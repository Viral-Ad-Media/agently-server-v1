"use strict";

/**
 * In-memory stand-in for the service-role Supabase client.
 *
 * WHY IT ENFORCES CONSTRAINTS
 *
 * The interesting failures in multi-account calendar support are failures to
 * respect the database's rules: overwriting one account's tokens with
 * another's, or leaving an organization with two booking targets. A fake that
 * cheerfully accepts any write cannot catch either, so this one implements
 * the two indexes from migrations/20261007_calendar_multi_account.sql:
 *
 *   calendar_integrations_org_provider_account_key
 *     unique (organization_id, provider, coalesce(provider_user_id, ''))
 *   calendar_integrations_one_booking_default_per_org
 *     unique (organization_id) where is_booking_default
 *
 * A violation rejects with code "23505", the same code PostgREST surfaces, so
 * a test can tell "the code inserted a duplicate" from "the code threw".
 *
 * It deliberately does NOT emulate row-level security: the real tables are
 * RLS-enabled with zero policies and the API is the service role, so the
 * production database does not filter by tenant either. Every cross-tenant
 * test here therefore measures the application's own scoping, which is the
 * only thing doing that job.
 */

function clone(row) {
  return JSON.parse(JSON.stringify(row));
}

function accountKey(row) {
  return [row.organization_id, row.provider, row.provider_user_id == null ? "" : row.provider_user_id].join("\u0000");
}

function uniqueViolation(constraint) {
  const error = new Error(`duplicate key value violates unique constraint "${constraint}"`);
  error.code = "23505";
  error.constraint = constraint;
  return error;
}

/**
 * Checks the calendar_integrations invariants over a proposed final state.
 * Returns an error object (PostgREST-shaped) or null.
 */
function checkCalendarIntegrations(rows) {
  const seenAccounts = new Map();
  const defaultsByOrg = new Map();
  for (const row of rows) {
    const key = accountKey(row);
    if (seenAccounts.has(key)) {
      return uniqueViolation("calendar_integrations_org_provider_account_key");
    }
    seenAccounts.set(key, row.id);
    if (row.is_booking_default) {
      if (defaultsByOrg.has(row.organization_id)) {
        return uniqueViolation("calendar_integrations_one_booking_default_per_org");
      }
      defaultsByOrg.set(row.organization_id, row.id);
    }
  }
  return null;
}

const CONSTRAINED_TABLES = { calendar_integrations: checkCalendarIntegrations };

function makeFakeSupabase(seed = {}) {
  const tables = {
    organizations: [],
    calendar_integrations: [],
    appointments: [],
    tenant_notifications: [],
    leads: [],
    business_groups: [],
    business_group_members: [],
    oauth_start_nonces: [],
  };
  for (const [name, rows] of Object.entries(seed)) {
    tables[name] = (rows || []).map(clone);
  }

  const stats = { queries: 0, inserts: 0, updates: 0, deletes: 0, byTable: {} };

  function note(table, kind) {
    stats[kind] += 1;
    stats.byTable[table] = stats.byTable[table] || { queries: 0, inserts: 0, updates: 0, deletes: 0 };
    stats.byTable[table][kind] += 1;
  }

  function from(tableName) {
    if (!tables[tableName]) tables[tableName] = [];
    const rows = tables[tableName];
    const filters = [];
    let pending = null; // { kind: "insert"|"update"|"delete", payload }
    let limitTo = null;

    function apply(row) {
      return filters.every(([op, column, value]) => {
        const actual = row[column];
        if (op === "eq") return actual === value;
        if (op === "neq") return actual !== value;
        if (op === "lt") return String(actual) < String(value);
        if (op === "lte") return String(actual) <= String(value);
        if (op === "gt") return String(actual) > String(value);
        if (op === "gte") return String(actual) >= String(value);
        if (op === "in") return value.includes(actual);
        if (op === "isNotNull") return actual !== null && actual !== undefined;
        return true;
      });
    }

    function matching() {
      const out = rows.filter(apply);
      return limitTo == null ? out : out.slice(0, limitTo);
    }

    function commit() {
      const check = CONSTRAINED_TABLES[tableName];

      if (pending && pending.kind === "insert") {
        note(tableName, "inserts");
        const incoming = (Array.isArray(pending.payload) ? pending.payload : [pending.payload]).map(clone);
        const next = rows.concat(incoming);
        if (check) {
          const violation = check(next);
          if (violation) return { data: null, error: violation };
        }
        rows.push(...incoming);
        return { data: incoming.map(clone), error: null };
      }

      if (pending && pending.kind === "update") {
        note(tableName, "updates");
        const targets = rows.filter(apply);
        const next = rows.map((row) =>
          targets.includes(row) ? { ...row, ...clone(pending.payload) } : row,
        );
        if (check) {
          const violation = check(next);
          if (violation) return { data: null, error: violation };
        }
        const updated = [];
        for (const row of targets) {
          Object.assign(row, clone(pending.payload));
          updated.push(clone(row));
        }
        return { data: updated, error: null };
      }

      if (pending && pending.kind === "delete") {
        note(tableName, "deletes");
        const targets = rows.filter(apply);
        for (const row of targets) rows.splice(rows.indexOf(row), 1);
        return { data: targets.map(clone), error: null };
      }

      note(tableName, "queries");
      return { data: matching().map(clone), error: null };
    }

    const api = {
      select() {
        return api;
      },
      eq(column, value) {
        filters.push(["eq", column, value]);
        return api;
      },
      neq(column, value) {
        filters.push(["neq", column, value]);
        return api;
      },
      lt(column, value) {
        filters.push(["lt", column, value]);
        return api;
      },
      lte(column, value) {
        filters.push(["lte", column, value]);
        return api;
      },
      gt(column, value) {
        filters.push(["gt", column, value]);
        return api;
      },
      gte(column, value) {
        filters.push(["gte", column, value]);
        return api;
      },
      in(column, values) {
        filters.push(["in", column, values]);
        return api;
      },
      not(column, operator, value) {
        if (operator === "is" && value === null) filters.push(["isNotNull", column, null]);
        return api;
      },
      order() {
        return api;
      },
      limit(n) {
        limitTo = n;
        return api;
      },
      insert(payload) {
        pending = { kind: "insert", payload };
        return api;
      },
      update(payload) {
        pending = { kind: "update", payload };
        return api;
      },
      delete() {
        pending = { kind: "delete" };
        return api;
      },
      async maybeSingle() {
        const { data, error } = commit();
        if (error) return { data: null, error };
        const list = Array.isArray(data) ? data : [data];
        if (list.length > 1) {
          // What PostgREST does, and the whole reason the one-row lookups had
          // to go: several rows where the caller promised one.
          return {
            data: null,
            error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" },
          };
        }
        return { data: list[0] || null, error: null };
      },
      async single() {
        const { data, error } = commit();
        if (error) return { data: null, error };
        const list = Array.isArray(data) ? data : [data];
        if (list.length !== 1) {
          return {
            data: null,
            error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" },
          };
        }
        return { data: list[0], error: null };
      },
      then(resolve, reject) {
        return Promise.resolve(commit()).then(resolve, reject);
      },
    };
    return api;
  }

  return {
    from,
    _tables: tables,
    _stats: stats,
    _rows(table) {
      return (tables[table] || []).map(clone);
    },
  };
}

module.exports = { makeFakeSupabase, accountKey };
