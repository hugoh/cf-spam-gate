# cf-spam-gate

A Cloudflare Worker that sits in front of [Cloudflare Email Routing](https://developers.cloudflare.com/email-routing/) and spam-gates incoming mail before it reaches your inbox: clean mail is forwarded as usual, spam is rejected at SMTP time. Fully configuration-driven — add or remove protected addresses, tune detection thresholds, and wire up domains without redeploying code.

Runs entirely on Cloudflare's free tier: a single Worker plus a KV namespace, no containers, no paid add-ons.

## How to use it

### 1. Deploy the worker

```sh
bun install
bunx wrangler kv namespace create ROUTES   # create the KV namespace, then paste its id into wrangler.toml
bunx wrangler deploy
```

In production, deployment is automated: pushing to `main` runs the test suite and, if it passes, `wrangler deploy` (see `.github/workflows/ci.yml`). That workflow needs two repo secrets: `CLOUDFLARE_API_TOKEN` (a token scoped to edit Workers, KV, and Email Routing) and `CLOUDFLARE_ACCOUNT_ID`.

### 2. Protect an address

Each protected recipient needs one entry in the `ROUTES` KV namespace, keyed by
the address itself. If you're wiring the address up via the
[terraform-cloudflare-spam-gate](https://github.com/hugoh/terraform-cloudflare-spam-gate)
OpenTofu module (step 3), it creates this entry for you — skip ahead. This
manual form is for quick testing, or for addresses managed some other way:

```sh
bunx wrangler kv key put --binding=ROUTES "you@example.com" \
  '{"destinations": ["you@your-real-inbox.example"], "threshold": 0.5}'
```

- `destinations` (required): where clean mail actually gets forwarded. Can be more than one address.
- `threshold` (optional): overrides the global `DEFAULT_THRESHOLD` var for this recipient only — e.g. a mailing-list address that gets a lot of borderline-spammy-looking mail might want a higher threshold than a personal address.

An address with no `ROUTES` entry is rejected outright rather than silently guessed at — this worker only handles addresses you've explicitly configured.

### 3. Point Cloudflare Email Routing at the worker

Use the
[terraform-cloudflare-spam-gate](https://github.com/hugoh/terraform-cloudflare-spam-gate)
OpenTofu module instead of a plain forwarding rule. It creates **both** the
routing rule and the recipient's `ROUTES` KV entry (step 2 above) — so for any
address managed this way, you don't need the manual `wrangler kv` command
separately; the module is the source of truth. It's also published on the
[OpenTofu Registry](https://registry.opentofu.org).

```hcl
resource "cloudflare_email_routing_settings" "example" {
  # ... your zone + email routing enablement, as usual
}

module "spam_gate_contact" {
  source              = "github.com/hugoh/terraform-cloudflare-spam-gate?ref=v0.1.0"
  zone_id             = cloudflare_zone.example.id
  from                = "contact@example.com"
  worker_script_name  = "cf-spam-gate" # must match `name` in wrangler.toml
  account_id          = var.account_id
  kv_namespace_id     = "..."          # the ROUTES namespace id from step 1
  destinations        = ["you@your-real-inbox.example"]
  threshold           = 0.5            # optional, per-recipient override
  depends_on          = [cloudflare_email_routing_settings.example]
}
```

Run with `tofu` (OpenTofu), not `terraform`. It's a separate repo from this
Worker on purpose — different tooling (pure OpenTofu vs. TypeScript/bun) and
its own independent release stream, so a Worker release never implies a
module release or vice versa.

**Pin `?ref=` to a released tag, not `main`.** Without it, `tofu` tracks
whatever's on that repo's default branch at plan time — including
in-progress changes — so a routine `tofu plan` elsewhere could pick up an
unreleased module change unexpectedly. The module repo's own
`.github/workflows/release.yml` cuts a semver tag on every merge to its
`main` (from conventional commit messages) — bump the `ref` when you
deliberately want a newer module version, same as bumping any other pinned
dependency.

### 4. Tune detection (optional)

`wrangler.toml`'s `[vars]` block controls global behavior:

| Var | Meaning |
|---|---|
| `DEFAULT_THRESHOLD` | Spam-score cutoff (0–1) used when a recipient has no per-address override. |
| `SIGNAL_WEIGHTS` | JSON weights for each detection signal (`content`, `url`, `header`, `dnsbl`) in the combined score. |
| `REJECT_MESSAGE` | Text returned to the sending MTA when a message is rejected. |

Optionally enable the DNSBL signal by setting a free [Spamhaus DQS](https://www.spamhaus.org/free-trial/sign-up-for-a-free-data-query-service-account/) key:

```sh
bunx wrangler secret put SPAMHAUS_DQS_KEY
```

Without a key, that signal is simply skipped (scored neutral, not "spam") — nothing breaks.

### 5. Retraining the content classifier

Manual only — there's no scheduled retrain workflow. The training corpus (Enron-Spam) is a fixed historical dataset that isn't updated upstream, so retraining on a timer would just reproduce the same model every time. Retrain when you change `scripts/train-model.config.mjs` (corpus URL, vocabulary size, or the stopword list) or want to pick up an update to the corpus source itself:

```sh
bun run train-model
```

Takes a few seconds — training itself is fast; most of the time is the ~15MB corpus download. Writes both `data/model.json` (the bundled model) and `data/model.meta.json` (when it was trained, from what corpus, with what settings — see `scripts/train-model.mjs`'s `buildMeta`).

### Local development

```sh
bun run test        # unit tests (vitest, Workers runtime pool)
bun run typecheck
bunx wrangler dev    # local dev server against a real KV binding
```

> **Use `bun run test`, not bare `bun test`.** Bun ships its own built-in test runner that auto-discovers `*.test.ts` files by naming convention, and bare `bun test` will grab them with its own incomplete Jest/Vitest-compatible shim instead of vitest — missing APIs like `vi.stubGlobal`, and no `workerd` runtime, so tests requiring Workers bindings fail outright. `bun run test` explicitly invokes the real `vitest run` from `package.json`'s script and is what CI runs.

## How it works

```text
Cloudflare Email Routing (per address, via terraform-cloudflare-spam-gate)
        │  action: type = "worker"
        ▼
   Worker email() handler
        │
        ├─ postal-mime          → parse the raw email
        ├─ @ladjs/naivebayes    → content classification (pretrained, bundled)
        ├─ tldts                → link/sender domain heuristics
        └─ Spamhaus DQS (opt.)  → DNSBL check on the connecting IP, best-effort
        │
        ▼
   weighted verdict vs. threshold
        │
        ├─ spam → message.setReject(reason)        (SMTP-time bounce, nothing stored)
        └─ ham  → look up recipient in KV ROUTES    → message.forward(destination)
```

### What Cloudflare already does, and why this worker doesn't duplicate it

Before a message ever reaches this Worker, Cloudflare's own Email Routing has already:

- **Enforced baseline authentication.** Since July 2025, incoming mail must pass SPF *or* be correctly DKIM-signed, or it's rejected outright — not just flagged. If the sending domain publishes a DMARC policy, Cloudflare also honors it (a `p=reject` policy means a failing message is rejected, full stop).
- **Run a built-in phishing filter.** A non-configurable heuristic layer that blocks known phishing patterns before a message is even offered for forwarding.
- **Added its own DKIM signatures on the way out**, so forwarded mail is more likely to itself pass authentication at the destination mailbox.

Because of this, re-verifying SPF/DKIM/DMARC inside the Worker would just repeat a check that already ran — a message reaching `email()` has, by definition, cleared that bar. So this worker doesn't touch SPF/DKIM/DMARC at all; it spends its whole budget on the gap Cloudflare leaves open:

- **No content-based scoring** — no keyword/ML classification of the message body.
- **No DNSBL/blocklist check** of the connecting IP.
- **No sender-reputation scoring** beyond the DKIM/SPF/DMARC pass-fail Cloudflare already applies.

Those three are exactly what this worker adds.

### Detection signals

- **Content** (`@ladjs/naivebayes`) — a Bayesian classifier trained offline (`scripts/train-model.mjs`) on the [Enron-Spam corpus](https://github.com/MWiechmann/enron_spam_data) and bundled as a JSON asset. The corpus's ham class is Enron's own internal email, so company-identifying tokens (`enron*`, `ect`, `hou`) are stripped before training — see `stripCorpusArtifacts` in `scripts/train-model.mjs`.
- **URL/domain** (`tldts`) — suspicious/free TLDs, IP-literal links, punycode/homograph domains, and sender-vs-link domain mismatches.
- **Header heuristics** — hand-written checks: missing/malformed `Date`, `Reply-To`/`From` domain mismatch, shouting subjects.
- **DNSBL** (optional) — checks the connecting client's IP (best-effort, extracted from the topmost `Received:` header — Workers' `email()` handler doesn't expose the SMTP connection IP directly) against Spamhaus via their [Data Query Service](https://www.spamhaus.org/resource-hub/email-security/if-you-query-the-legacy-dnsbls-via-cloudflares-dns-move-to-spamhaus-technologys-free-data-query-service/). DQS is used instead of the legacy public `zen.spamhaus.org` zone because Spamhaus silently returns "not listed" for anything queried through a major public resolver (Cloudflare's own 1.1.1.1 included) — DQS ties authorization to a registered key instead, so it works reliably from a Worker. Reversed-name construction (for both IPv4 and IPv6) uses the `ip-ptr` package. Failure or absence of a usable IP scores neutral, never as spam evidence.

### Why not the `spamscanner` npm package

The [spamscanner](https://github.com/spamscanner/spamscanner) project this worker is inspired by depends on `@tensorflow/tfjs-node` (native bindings), a system ClamAV binary, and 2GB+ of RAM — none of which fit in a Workers V8 isolate. The only way to run it for real is fronting a [Cloudflare Container](https://developers.cloudflare.com/containers/), which requires a paid plan. This worker deliberately stays on the free tier, so instead of the `spamscanner` package itself, it reuses several of the same ecosystem's pure-JS building blocks (`postal-mime`, `@ladjs/naivebayes`) that don't need a container, plus `tldts` for domain heuristics.

We also evaluated the `dnsbl` npm package for the DNSBL signal — it depends on Node's raw UDP `dns.Resolver` against custom nameservers, which Workers doesn't support, so that package can't run here. Its `ip-ptr` dependency (pure reverse-name string logic, no networking) is Workers-safe on its own, so we use that directly against Spamhaus DQS over DoH instead.

### Known limitations

- DNSBL is best-effort: it depends on a `Received:` header actually containing the true connecting IP, which isn't guaranteed for every mail path.
- No virus/attachment scanning, no NSFW/toxicity detection — those are the TensorFlow/ClamAV features `spamscanner` proper has that this worker intentionally doesn't replicate.

## License

GPLv3 — see [LICENSE](./LICENSE). (Chosen because the bundled training corpus, [Enron-Spam via MWiechmann/enron_spam_data](https://github.com/MWiechmann/enron_spam_data), is GPLv3-licensed; keeping this repo under the same license avoids any ambiguity about training on it.)
