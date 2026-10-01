# dsh-plugin-publish

Publish a DSH plugin to GitHub in one command. The result is a public repository
any other machine can install the plugin from.

```sh
npx dsh-plugin-publish ./my-plugin --token <token> --yes
```

## What it does

1. **Validates the plugin locally** — before anything touches the network.
2. Creates the GitHub repository (or reuses it).
3. Uploads the whole tree as one commit.
4. Sets the `dsh-plugin` topic.
5. **Prints the install commands** for another machine.

```
Published: https://github.com/you/my-plugin

Install it on another machine with:
  dsh plugin --profile desktop add github:you/my-plugin
      (resolves through git; that machine needs git installed)

  dsh plugin --profile desktop add https://codeload.github.com/you/my-plugin/tar.gz/HEAD
      (fetched over HTTPS; no git needed)
```

Both commands are printed because which one works depends on the installing
machine: the `github:` form is resolved through git, while the codeload URL is
fetched over HTTPS. A commit-pinned URL is offered too, for installing exactly
what was published rather than following `HEAD`.

## What it validates, and why

Every check exists because the DSH loader fails on it, and each failure is silent
or confusing where it happens:

| Check | What goes wrong without it |
| --- | --- |
| `dsh.bundle` is declared | `dsh plugin add` cannot install the package at all |
| The patch file exists | The bundle layer has nothing to apply |
| The patch row `name` matches the package | The module is never found |
| The browser bundle `id` matches the package | **The browser half never loads, with no error** |
| No credential-shaped files | A token in a public repository is compromised on push |

The last two are the dangerous ones: the plugin looks installed and simply does
nothing. All of this runs **before** any network use, so a broken manifest cannot
half-publish a repository.

## Install

As a DSH plugin — adds a `/publish-plugin` command inside the harness:

```sh
dsh plugin --profile desktop add github:Gty2408/dsh-plugin-publish
```

Then, in any session:

```
/publish-plugin                    # validate the plugin in the workspace
/publish-plugin --push             # validate, then publish it
/publish-plugin ./my-plugin --push --repo custom-name
```

The token is read from `~/.dsh/.github-token` (a classic token with the `repo`
scope), or from the plugin's `token` config.

As a standalone CLI, for use outside the harness:

```sh
npx dsh-plugin-publish --help
```

## Two ways to authenticate

| Route | When |
| --- | --- |
| **Device flow** (default) | Interactive. Prints a short code, you authorize in the browser. No token to paste. |
| **`--token`** | Non-interactive, or when `github.com` is unreachable but `api.github.com` works. |

The device flow talks to `github.com`; the API calls talk to `api.github.com`.
Those two hosts can differ in reachability — measured on one network,
`api.github.com` answered in ~185 ms while `github.com` failed to connect after
~22 s — which is why the token route exists.

## Safety rails

- **Validate before any network use.** A manifest problem aborts locally.
- **The token is scrubbed from every message.** API errors often echo the
  request; `scrubSecrets` removes classic and fine-grained token shapes, and any
  token embedded in a URL, before anything is shown or logged.
- **Never publishes credentials.** Files matching credential patterns are
  reported before upload.
- **Never force-pushes** unless `--force` is given.
- **Reports partial progress.** A failure halfway leaves a repository behind, so
  the output names what already happened.
- **Revocation reminder.** Every run ends by pointing at the revoke page.

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

## Known limits

- The `repo` scope **cannot delete repositories** — that needs `delete_repo`. So
  the tool never offers to clean up; deleting is a manual step.
- This tool publishes to GitHub. It does not submit to the plugin marketplace,
  and it does not publish to npm.
- `--force` overwrites the branch. Without it, an existing branch with commits
  is left alone.

## Requirements

- Node.js 20+
- A GitHub account

## License

MIT