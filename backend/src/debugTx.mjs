import { Agent, setGlobalDispatcher } from "undici";
setGlobalDispatcher(new Agent({ connect: { family: 4 } }));
import dotenv from "dotenv";
dotenv.config();
import { rpc } from "./genlayerRelayer.js";

const hash = process.argv[2];
const tx = await rpc("eth_getTransactionByHash", [hash]);
const lr = tx?.consensus_data?.leader_receipt;
const receipts = Array.isArray(lr) ? lr : [lr];
console.log("status:", tx?.status);
console.log("votes:", JSON.stringify(tx?.consensus_data?.votes ?? null));
for (const r of receipts) {
  if (!r) continue;
  console.log("execution_result:", r.execution_result);
  let detail = r.result ?? "";
  try {
    detail = Buffer.from(String(detail), "base64").toString("utf8");
  } catch {}
  console.log("result:", String(detail).replace(/[^\x20-\x7e\n]/g, " ").slice(0, 3000));
  if (r.genvm_result) {
    console.log("stdout:", String(r.genvm_result.stdout || "").slice(0, 2000));
    console.log("stderr:", String(r.genvm_result.stderr || "").slice(0, 4000));
  }
  if (r.eq_outputs) console.log("eq_outputs:", JSON.stringify(r.eq_outputs).slice(0, 1500));
}
