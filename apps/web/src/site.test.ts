/**
 * The page's data (site.ts): the nav reaches every section in page order;
 * every integration card links to a file that exists at the commit the page
 * links to and says how real it is, and where it runs, without claiming a
 * deployment; the sealed-evidence intro states the rule the ledger applies.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  EVIDENCE_LEDE,
  GLOSSARY,
  GLOSSARY_ID,
  INTEGRATIONS,
  LEDGER_FILE,
  LINKED_FILES,
  NAV_SECTIONS,
  REPO_REF,
  repoFile,
} from "./site";
import { parseFundSnapshot } from "./fund/types";

const repo = (p: string) => new URL(`../../../${p}`, import.meta.url);
const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const context = readFileSync(new URL("./fund/Context.tsx", import.meta.url), "utf8");
const snapshot = () =>
  parseFundSnapshot(JSON.parse(readFileSync(new URL("../public/fund-snapshot.json", import.meta.url), "utf8")) as unknown);

test("the nav lists every section after the hero, in page order", () => {
  assert.deepEqual(
    NAV_SECTIONS.map((s) => s.id),
    ["guarantees", "fund-console", "evidence", "center-book", "integrations", "under-the-hood"],
  );
  assert.equal(new Set(NAV_SECTIONS.map((s) => s.id)).size, NAV_SECTIONS.length);
  for (const s of NAV_SECTIONS) {
    assert.ok(s.label && s.short && s.hint, s.id);
    // Each target exists in App.tsx and marks itself for the active-section observer.
    assert.match(app, new RegExp(`id="${s.id}"[^>]*data-nav="${s.id}"`), `section #${s.id} with data-nav`);
  }
  // The hero is the brand link's target.
  assert.match(app, /id="top" data-nav="top"/);
  assert.match(app, /className="nav-brand" href="#top"/);
  // The sections appear in App.tsx's render in the same order as the nav.
  const order = ["<Hero />", "<Guarantees />", "<FundConsoleSection", "<EvidenceSection", "<CenterBookSection />", "<IntegrationsSection />", "<UnderTheHood />"];
  const at = order.map((tag) => app.indexOf(tag, app.indexOf("<main")));
  assert.ok(at.every((i) => i > 0), "every section is rendered inside <main>");
  assert.deepEqual([...at].sort((a, b) => a - b), at, "render order");
});

test("every integration card links to a file that exists", () => {
  assert.ok(INTEGRATIONS.length >= 6);
  for (const it of INTEGRATIONS) {
    assert.ok(existsSync(repo(it.file)), `${it.name}: ${it.file} exists`);
    if (it.see) assert.match(app, new RegExp(`id="${it.see.href.slice(1)}"`), `${it.name}: ${it.see.href} exists`);
  }
  assert.ok(existsSync(repo(LEDGER_FILE)));
});

/*
 * GitHub's main lagged the branch the loops are pushed to and lacked two of
 * the linked docs, so `blob/main/` links 404ed. The links are pinned to
 * REPO_REF: it must be a commit of this page's own history (pushing the page
 * pushes it) that holds every linked file.
 */
test("every GitHub link points at a commit in this history that holds the file", (t) => {
  const root = fileURLToPath(repo(""));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  let shallow: boolean;
  try {
    shallow = git("rev-parse", "--is-shallow-repository") === "true";
  } catch {
    t.skip("not a git checkout");
    return;
  }
  const has = (spec: string) => {
    try {
      git("cat-file", "-e", spec);
      return true;
    } catch {
      return false;
    }
  };
  if (!has(`${REPO_REF}^{commit}`)) {
    if (shallow) {
      t.skip(`shallow clone without ${REPO_REF}`);
      return;
    }
    assert.fail(`REPO_REF ${REPO_REF} is not a commit in this repository`);
  }
  assert.doesNotThrow(() => git("merge-base", "--is-ancestor", REPO_REF, "HEAD"), "REPO_REF is in HEAD's history");
  for (const f of LINKED_FILES) assert.ok(has(`${REPO_REF}:${f}`), `${f} exists at ${REPO_REF.slice(0, 7)}`);
  // Links are built from the pinned ref, never from a branch name.
  assert.equal(repoFile("docs/LOOPS.md"), `https://github.com/J-Buchen/hackathon/blob/${REPO_REF}/docs/LOOPS.md`);
  assert.doesNotMatch(app, /blob\/(main|master)\//);
  assert.match(app, /repoFile\(it\.file\)/);
  assert.match(app, /repoFile\(LEDGER_FILE\)/);
});

test("integration statuses are honest: mocks say mock, nothing claims a deployment or live funds", () => {
  const by = new Map(INTEGRATIONS.map((i) => [i.name, i]));
  assert.match(by.get("AgentHire")!.status, /runs locally/);
  assert.match(by.get("AgentHire")!.status, /simulated/);
  assert.match(by.get("AgentHire")!.usedIn, /unmodified, keyless AgentHire/);
  assert.match(by.get("World ID")!.status, /mock verifier/);
  assert.match(by.get("ENS")!.status, /mock/);
  assert.match(by.get("ENS")!.usedIn, /nothing is registered on a chain/);
  assert.equal(by.get("Intercepta")!.status, "mock");
  assert.equal(by.get("1inch Aqua")!.status, "mock");
  assert.match(by.get("Uniswap v4 SpendCapHook")!.status, /contract \+ tests · not deployed/);
  for (const it of INTEGRATIONS) {
    const text = `${it.status} ${it.what} ${it.usedIn}`;
    assert.doesNotMatch(text, /\b(live|mainnet|production|audited)\b/i, it.name);
    assert.doesNotMatch(text.replace(/not deployed/g, ""), /\bdeployed\b/i, it.name);
    assert.doesNotMatch(text, /\bescrow\b/i, `${it.name}: no escrow claims`);
    assert.doesNotMatch(text, /\bslash/i, `${it.name}: a blocked overspend is not a slash`);
    assert.ok(it.what.length > 40 && !/\.\s+[A-Z]/.test(it.what), `${it.name}: one sentence`);
    // The chip fits one line on a phone card (about 48 characters at 390 px).
    assert.ok(it.status.length <= 40, `${it.name}: status chip "${it.status}" is short`);
  }
});

test("each card says where it runs, and the fund console runs none of them", () => {
  const by = new Map(INTEGRATIONS.map((i) => [i.name, i]));
  // No fund, arena or allocator code calls an adapter: the console's operators
  // and names are simulated. Where each one does run:
  assert.match(by.get("World ID")!.usedIn, /AgentHire run and the payment demo, through a mock verifier/);
  assert.match(by.get("World ID")!.usedIn, /fund console's operators are simulated labels/);
  assert.match(by.get("1inch Aqua")!.usedIn, /payment demo only/);
  assert.match(by.get("Uniswap v4 SpendCapHook")!.usedIn, /off-chain mirror/);
  assert.match(by.get("Uniswap v4 SpendCapHook")!.usedIn, /contract itself runs only in its tests/);
  for (const it of INTEGRATIONS) assert.doesNotMatch(it.usedIn, /\bthe fund (uses|runs)\b/i, it.name);
  // The page says so, and does not imply the listed six feed the fund.
  const flat = app.replace(/\s+/g, " ");
  assert.match(flat, /The fund console runs none of their code/);
  assert.doesNotMatch(flat, /the fund does not use them/);
  // The hero does not claim a verifier runs in the console.
  assert.match(flat, /the console's operators are simulated labels and the AgentHire run uses a mock verifier/);
  // The footer scopes "simulated" to the fund results: the worked example cites real sources.
  assert.doesNotMatch(flat, /nothing is market data\./);
  assert.match(flat, /Every fund result on this page is simulated \(virtual worlds and synthetic prices\); the worked example's research notes cite real sources, but its prices are synthetic\./);
});

test("the evidence intro states the rule the ledger applies (docs/LOOPS.md, Protocol)", () => {
  const loops = snapshot().evidence.loops;
  const merged = loops.filter((l) => l.confirmed && l.merged.length > 0);
  // Loop 3 merged on a block-B interval that crosses zero (a structural
  // change only has to be neutral), so "only when a change wins" would be false.
  const crossing = merged.filter((l) => l.blockB && l.blockB.allocator.lo <= 0);
  assert.ok(crossing.length > 0, "the committed ledger has a merged loop whose block-B interval crosses zero");
  if (crossing.length > 0) assert.doesNotMatch(EVIDENCE_LEDE, /only when a change wins/i);
  if (merged.some((l) => l.merged.some((m) => m.track === "structure")))
    assert.match(EVIDENCE_LEDE, /a structural guarantee must stay neutral on both/);
  // Loop 1's stop ceiling was merged after the push, at a cost.
  if (loops.some((l) => l.correctedB)) assert.match(EVIDENCE_LEDE, /a fix found after a push is recorded with its cost/);
  assert.match(EVIDENCE_LEDE, /return or drawdown claim must win world by world/);
  assert.ok(EVIDENCE_LEDE.split(/\.\s+(?=[A-Z])/).length <= 2, "at most two sentences");
  assert.match(app, /\{EVIDENCE_LEDE\}/, "App.tsx renders the tested intro");
});

test("each term is defined once: the glossary, which the context card points to", () => {
  assert.deepEqual(
    GLOSSARY.map((g) => g.term),
    ["Sealed worlds", "Block A, block B", "Certainty equivalent", "90% interval"],
  );
  for (const g of GLOSSARY) {
    // Block sizes live in the data (the evidence panel reads them), not here.
    assert.doesNotMatch(g.def, /\b\d{2,}\b/, `${g.term}: no hard-coded world count`);
    // A structural change is confirmed neutral, not "won": no definition says every merge wins.
    assert.doesNotMatch(g.def, /\bwins?\b/, g.term);
  }
  assert.match(app, new RegExp(`id=\\{GLOSSARY_ID\\}`));
  assert.equal(GLOSSARY_ID, "evidence-terms");
  // The context card links to it instead of defining the same words again.
  assert.match(context, /href=\{`#\$\{GLOSSARY_ID\}`\}/);
  assert.doesNotMatch(context, /sure yearly return|no researcher saw/);
});
