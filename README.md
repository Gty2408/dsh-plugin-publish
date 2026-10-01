# dsh-plugin-publish

One command to publish a DSH plugin to GitHub — creates the repo, uploads the
tree, sets the required topic, and writes the `awesome-dsh-plugin` catalog entry
you submit as a PR.

```sh
npx dsh-plugin-publish            # publish the plugin in the current directory
```

## Why this exists

Publishing a DSH plugin means getting four things right, none of which the
harness does for you:

1. **The manifest shape.** The awesome-list CI rejects any repo whose
   `package.json` declares only `dsh.client` — it requires `dsh.bundle`, plus a
   `cordis.patch.yml` beside it. This is the single most common rejection.
2. **Three identifiers that must agree.** `package.json` `name`,
   `cordis.patch.yml`'s row `name`, and the `__ModuleLoader__.load({ id })` in the
   browser bundle. If they disagree the browser half silently never loads.
3. **The `dsh-plugin` topic.** A hard requirement, checked by CI.
4. **The catalog entry.** A YAML file whose `description.en` must be quoted when
   it contains `: `, or the parser reads it as a nested key.

This tool checks all four before it touches the network, then does the upload.

## What it does

| Step | Detail |
| --- | --- |
| Preflight | Validates manifest, the three identifiers, topic, and tests |
| Auth | GitHub **device flow** — no token to paste, no password shared |
| Create | Creates the public repo (or reuses an existing one) |
| Upload | Pushes the whole tree in one commit, preserving directories |
| Topic | Sets `dsh-plugin` and related topics |
| Catalog | Writes `<owner>__<repo>.yml` for the awesome-list PR |

## Safety rails

- **Dry run by default?** No — but `--dry-run` validates and prints the plan
  without touching the network.
- **Never force-pushes.** If the branch already has commits, it refuses unless
  `--force` is passed, and it shows what would be overwritten first.
- **Never publishes secrets.** Files matching common credential patterns are
  reported and skipped.
- **Token handling.** The device-flow token is written to a `0600` file outside
  the repo and deleted when the run ends. It is never printed.
- **Revocation reminder.** Every run ends by telling you where to revoke access.

## Install

As a DSH plugin — adds a `/publish-plugin` command inside the harness that does
the whole job:

```sh
dsh plugin --profile desktop add github:Gty2408/dsh-plugin-publish
```

Then, in any session:

```
/publish-plugin                    # validate the plugin in the workspace
/publish-plugin --push             # validate, then publish it
/publish-plugin ./my-plugin --push --category ui
```

The token is read from `~/.dsh/.github-token` (a classic token with the `repo`
scope), or from the plugin's `token` config.

As a standalone CLI, for use outside the harness:

```sh
npx dsh-plugin-publish ./my-plugin --token <token> --yes
npx dsh-plugin-publish --help
```

## Two ways to authenticate

| Route | When |
| --- | --- |
| **Device flow** (default) | Interactive. Prints a short code, you authorize in the browser. No token to paste. |
| **`--token`** | Non-interactive, or when `github.com` is unreachable but `api.github.com` works. |

The device flow talks to `github.com`; the API calls talk to `api.github.com`.
Those two hosts can differ in reachability, which is why the token route exists.

## What the plugin command does

```
/publish-plugin [directory] [--push] [--repo name] [--category name]
```

Without `--push` it validates and prints the catalog entry it would submit.
With `--push` it validates, then creates the repo, uploads the tree, sets the
required topic, and writes the catalog entry file.

Validation **always** runs first and never touches the network, so a broken
manifest cannot half-publish a repository.

## Safety rails

- **Validate before any network use.** A manifest problem aborts locally.
- **Never force-pushes** unless `force: true` is set in the config.
- **Never publishes secrets.** Files matching credential patterns are reported.
- **Reports partial progress.** A failure halfway leaves a repo behind, so the
  output names what already happened.
- **Token handling.** The device-flow token is written to a `0600` file outside
  the repo and deleted when the run ends. It is never printed.
- **Revocation reminder.** Every run ends by pointing at the revoke page.

## Known limits

- The `repo` scope **cannot delete repositories** — that needs `delete_repo`. So
  the tool never offers to clean up; deleting is a manual step.
- The catalog entry is written next to the plugin, not committed: submitting it
  is a PR to `awesome-dsh-plugin`, which the tool does not open for you.
- The target repo must be **at least 1 day old** before that PR passes CI.

## Tests

```sh
node test/run.mjs
```

The suite is **hermetic**: no network, no credential, no account. Every branch of
the push path — the empty-repo seed, the blob/tree/commit/ref sequence, the 409
case, error propagation, retry behaviour — runs against a fake GitHub that speaks
the same REST surface. `hermetic.test.mjs` enforces that property by scanning the
other suites for a credential read or an unmocked call.

This is deliberate. An earlier version published to a real repository on every
run to prove the flow worked; since the `repo` scope cannot delete repositories,
each run left an artifact the user had to remove by hand. A test that writes to a
real account is a side effect with assertions attached, not a test.

### Verifying the real network path

The live path is checked once, deliberately, by a script that is **not** part of
the suite:

```sh
node test/live-verify.mjs --i-know-this-creates-a-repo
```

It refuses to run without that flag, reuses one fixed repository name so repeated
runs never accumulate, and prints the cleanup URL when it finishes.

## Requirements

- Node.js 20+
- A GitHub account

## License

MIT