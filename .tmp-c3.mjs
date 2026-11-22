import { readFileSync } from "node:fs";
const snap=JSON.parse(readFileSync("src/data/etf-share/daily/2026-11-20.json","utf8"));
const sc=x=>(x.share*(x.close||1)/1e8);
const dump=(label,re,ex)=>{const hit=snap.items.filter(x=>re.test(x.name)&&!(ex&&ex.test(x.name))).sort((a,b)=>sc(b)-sc(a));
console.log("\n## "+label+" ("+hit.length+")");console.log(hit.slice(0,12).map(x=>x.code+" "+x.name+" "+sc(x).toFixed(0)+"亿").join(" | "));};
dump("中证500",/500/,/A500|标普500|500价值|500增强|500指增|500质量|500成长/);
dump("中证1000",/1000/,/价值|增强|指增|科创债|300/);
dump("科创50",/科创50|科创板50|科创ETF|上证科创/);
dump("创业板指",/^创业板ETF|创50ETF/);
