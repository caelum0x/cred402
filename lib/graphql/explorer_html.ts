/**
 * A self-contained, dependency-free in-browser GraphQL explorer served at
 * /graphiql — write a query, run it against /graphql, see the JSON result.
 */
export const GRAPHIQL_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cred402 · GraphQL Explorer</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;background:#0b0e14;color:#e8ecf4;font:14px ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif;height:100vh;display:flex;flex-direction:column}
  header{padding:12px 18px;border-bottom:1px solid #2a3140;display:flex;align-items:center;gap:10px}
  header b{color:#7c8aff}
  .main{flex:1;display:grid;grid-template-columns:1fr 1fr;gap:0;min-height:0}
  textarea,pre{margin:0;border:none;padding:16px;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:#0c0f16;color:#cfe3ff;height:100%;width:100%;resize:none;outline:none;overflow:auto}
  pre{border-left:1px solid #2a3140;white-space:pre-wrap}
  .bar{padding:8px 18px;border-bottom:1px solid #2a3140;display:flex;gap:8px;align-items:center}
  button{background:#7c8aff;color:#06080d;border:none;border-radius:8px;padding:8px 18px;font-weight:600;cursor:pointer}
  select{background:#161a24;color:#e8ecf4;border:1px solid #2a3140;border-radius:8px;padding:7px}
</style></head>
<body>
  <header><b>◆ Cred402</b> GraphQL Explorer <span style="color:#8a93a6">POST /graphql</span></header>
  <div class="bar">
    <button id="run">▶ Run (Ctrl/Cmd+Enter)</button>
    <select id="samples">
      <option value="{ agents { agent_id reputation_score credit_score } }">agents</option>
      <option value="{ analytics }">analytics</option>
      <option value="{ creditExplain(agentId: &quot;EvidenceSellerAgent&quot;) }">creditExplain</option>
      <option value="{ marketplace { listing_id category strategy reputation_score } }">marketplace</option>
      <option value="{ agentProfile(id: &quot;EvidenceSellerAgent&quot;) }">agentProfile</option>
      <option value="mutation { drawCredit(agent_id: &quot;EvidenceSellerAgent&quot;, amount_cspr: 2) }">mutation: drawCredit</option>
    </select>
  </div>
  <div class="main">
    <textarea id="q" spellcheck="false">{ agents { agent_id reputation_score credit_score } }</textarea>
    <pre id="out">// result appears here</pre>
  </div>
<script>
  const q=document.getElementById('q'),out=document.getElementById('out');
  async function run(){
    out.textContent='// running...';
    try{
      const res=await fetch('/graphql',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:q.value})});
      out.textContent=JSON.stringify(await res.json(),null,2);
    }catch(e){out.textContent=String(e);}
  }
  document.getElementById('run').onclick=run;
  document.getElementById('samples').onchange=e=>{q.value=e.target.value;run();};
  q.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter')run();});
  run();
</script>
</body></html>`;
