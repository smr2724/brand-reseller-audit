import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
const auth = "Basic " + Buffer.from(`${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`).toString("base64");
(async () => {
  const r = await fetch("https://api.dataforseo.com/v3/appendix/user_data", { headers: { Authorization: auth }});
  const d = await r.json();
  console.log("balance:", JSON.stringify(d?.tasks?.[0]?.result?.[0], null, 2));
  const r2 = await fetch("https://api.dataforseo.com/v3/serp/google/locations", { headers: { Authorization: auth }});
  console.log("serp endpoint accessible:", r2.status);
})();
