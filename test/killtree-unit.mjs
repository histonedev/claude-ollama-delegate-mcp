import { spawnClaude, killTree } from "../dist/platform.js";
import { execSync } from "node:child_process";
const n = (pat) => { try { return +execSync(`pgrep -f ${JSON.stringify(pat)} | wc -l`).toString().trim(); } catch { return 0; } };

// Stand-in for the CLI: a process that itself spawns a long-running grandchild.
const proc = spawnClaude("/bin/sh", ["-c", "sleep 941 & sleep 942 & wait"], { stdio: "ignore" });
console.log(`spawned pid ${proc.pid} (detached group leader: ${process.platform !== "win32"})`);
await new Promise(r => setTimeout(r, 1500));
console.log(`BEFORE  parent sh: ${n("sleep 941 & sleep 942")}   grandchildren: ${n("sleep 941") + n("sleep 942")}`);

killTree(proc, "SIGTERM");
await new Promise(r => setTimeout(r, 2000));

const after = n("sleep 941") + n("sleep 942");
console.log(`AFTER   grandchildren: ${after}`);
console.log(after === 0 ? "\nPASS: whole process tree terminated" : "\nFAIL: orphaned grandchildren survived");

// Contrast: plain proc.kill() leaves the grandchildren behind.
const p2 = spawnClaude("/bin/sh", ["-c", "sleep 951 & wait"], { stdio: "ignore" });
await new Promise(r => setTimeout(r, 1500));
p2.kill("SIGTERM");
await new Promise(r => setTimeout(r, 2000));
const leaked = n("sleep 951");
console.log(`\ncontrol (plain proc.kill): orphans left = ${leaked} ${leaked > 0 ? "<- the bug killTree fixes" : ""}`);
try { execSync("pkill -f 'sleep 95[0-9]'"); } catch {}
process.exit(after === 0 ? 0 : 1);
