"use strict";
const crypto = require("crypto");
const gmail = require("./gmail-send");

// Persist the claim BEFORE talking to Gmail. A crash/timeout is uncertain, never
// permission to send again. Only known pre-send/provider rejections may retry.
async function sendOnce(db, organizationId, key, params, send = gmail.sendGmail) {
  const id = crypto.createHash("sha256").update(`${organizationId}:${key}`).digest("hex");
  const inserted = await db.from("operator_send_receipts").insert({id,organization_id:organizationId,status:"processing"});
  if(inserted.error) {
    if(inserted.error.code !== "23505") throw inserted.error;
    const {data,error} = await db.from("operator_send_receipts").select("status,result").eq("organization_id",organizationId).eq("id",id).maybeSingle();
    if(error) throw error;
    if(data?.status === "sent") return {...data.result,replayed:true};
    if(data?.status !== "failed") throw Object.assign(new Error("The previous send may have reached Gmail. Check Sent before trying another draft; this send was not repeated."),{code:"delivery_uncertain"});
    const claimed = await db.from("operator_send_receipts").update({status:"processing"}).eq("organization_id",organizationId).eq("id",id).eq("status","failed").select("id").maybeSingle();
    if(claimed.error) throw claimed.error;
    if(!claimed.data) throw new Error("This send is already being processed.");
  }
  try {
    const result = await send(db,organizationId,params);
    const saved=await db.from("operator_send_receipts").update({status:"sent",result}).eq("organization_id",organizationId).eq("id",id);
    if(saved.error) throw Object.assign(new Error("Gmail accepted the email but its receipt could not be saved. Check Sent; do not resend."),{code:"delivery_uncertain"});
    return result;
  } catch(error) {
    const known = ["needs_reconnect","daily_cap","gmail_not_connected","invalid_recipient","missing_subject","missing_body","body_too_long","EMAIL_RECIPIENT_BLOCKED","blocked"].includes(error.code);
    await db.from("operator_send_receipts").update({status:known ? "failed" : "uncertain",result:{message:error.message}}).eq("organization_id",organizationId).eq("id",id);
    throw error;
  }
}
module.exports={sendOnce};
