// Inside chatbot.routes.js, after other routes, add:

const { scrapeAndStore } = require("../../lib/scraper.service");

router.post("/:id/import-website", requireAuth, async (req, res) => {
  try {
    const { website } = req.body;
    if (!website?.trim())
      return res
        .status(400)
        .json({ error: { message: "website URL required" } });
    const db = getSupabase();
    const { data: chatbot } = await db
      .from("chatbots")
      .select("id")
      .eq("id", req.params.id)
      .eq("organization_id", req.orgId)
      .single();
    if (!chatbot)
      return res.status(404).json({ error: { message: "Chatbot not found" } });
    const { data: org } = await db
      .from("organizations")
      .select("name")
      .eq("id", req.orgId)
      .single();
    const result = await scrapeAndStore({
      url: website,
      chatbotId: req.params.id,
      organizationId: req.orgId,
      orgName: org?.name || "Business",
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});
