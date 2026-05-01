import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";

(async () => {
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  await supabase.auth.signInWithPassword({ email: "steve@rollemanagementgroup.com", password: "LegionScan2026!" });
  const { data } = await supabase.from("opportunities")
    .select("name, main_keyword, legion_score, recommended_path, top_10_avg_reviews, monthly_search_volume, total_cluster_search_volume, avg_price, summary, why_excited, why_skeptical")
    .gte("legion_score", 80).lt("top_10_avg_reviews", 500)
    .order("legion_score", { ascending: false }).order("top_10_avg_reviews", { ascending: true });
  fs.writeFileSync("/home/user/workspace/winners.json", JSON.stringify(data, null, 2));
  console.log(`Saved ${data?.length} winners`);
})();
