/**
 * Mock fallback data — used when DataForSEO/Keepa are missing or fail.
 * Seeded-deterministic so the same keyword always returns the same shape.
 */
import type { DfsKeyword, DfsProduct } from "./dataforseo";

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h);
}

function rng(seed: number) {
  let s = seed || 1;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

const KEYWORD_MODIFIERS = [
  "", "best", "commercial", "industrial", "heavy duty", "professional", "for concrete",
  "for garage", "gallon", "5 gallon", "for driveway", "for contractors", "for shower",
  "spray", "liquid", "near me", "bulk", "reviews", "amazon", "commercial grade",
];

export function mockKeywords(seed: string): DfsKeyword[] {
  const rand = rng(hash(seed));
  const baseVol = Math.floor(500 + rand() * 8_000);
  const out: DfsKeyword[] = [{ keyword: seed, search_volume: baseVol }];
  for (const mod of KEYWORD_MODIFIERS.slice(1)) {
    const prefix = mod.endsWith(" ") || mod.length === 0 ? mod : mod + " ";
    const kw = mod.startsWith("for ") || mod === "reviews" || mod === "amazon" || mod === "near me" || mod === "bulk" || mod === "gallon" || mod === "5 gallon" || mod === "spray" || mod === "liquid" || mod === "commercial grade"
      ? `${seed} ${mod}`
      : `${prefix}${seed}`;
    out.push({ keyword: kw, search_volume: Math.floor(rand() * baseVol * 0.6) });
  }
  return out;
}

// Pretend ASINs
function fakeAsin(seed: string, i: number) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const rand = rng(hash(seed + ":" + i));
  let s = "B0";
  for (let k = 0; k < 8; k++) s += alphabet[Math.floor(rand() * alphabet.length)];
  return s;
}

export function mockProducts(seed: string): DfsProduct[] {
  const rand = rng(hash("serp:" + seed));
  const kwLower = seed.toLowerCase();

  // Commodity categories → strong competition
  const commodity = ["laundry detergent", "dish soap", "hand soap", "body wash", "shampoo", "toothpaste", "cereal"];
  const isCommodity = commodity.some(c => kwLower.includes(c));

  const n = 20;
  const products: DfsProduct[] = [];
  for (let i = 0; i < n; i++) {
    const isTop3 = i < 3;
    let reviewCount: number;
    let rating: number;
    let price: number;
    if (isCommodity) {
      reviewCount = isTop3 ? 25_000 + Math.floor(rand() * 60_000) : 5_000 + Math.floor(rand() * 30_000);
      rating = 4.4 + rand() * 0.4;
      price = 6 + rand() * 18;
    } else {
      // Legion-like: weak-to-medium competition
      reviewCount = isTop3
        ? 300 + Math.floor(rand() * 2000)
        : Math.floor(rand() * 800);
      rating = 3.8 + rand() * 0.7;
      price = 24 + rand() * 45;
    }
    products.push({
      asin: fakeAsin(seed, i),
      title: `${capitalize(seed)} — ${["Heavy Duty", "Commercial", "Fast Acting", "Professional Grade", "Eco", "Industrial", "Max Strength"][i % 7]} ${i + 1}`,
      brand: isCommodity
        ? ["Tide", "Gain", "Persil", "Arm & Hammer"][i % 4]
        : ["Acme Chem", "ProClean Co", "NorthStar Industrial", "Zenith Supply", "Redline Products", "Pinnacle Pro"][i % 6],
      price: Math.round(price * 100) / 100,
      rating: Math.round(rating * 10) / 10,
      review_count: reviewCount,
      image_url: undefined,
      product_url: `https://www.amazon.com/dp/${fakeAsin(seed, i)}`,
      position: i + 1,
      is_sponsored: i === 0 || i === 3 || i === 7,
    });
  }
  return products;
}

function capitalize(s: string) {
  return s.replace(/\b\w/g, m => m.toUpperCase());
}
