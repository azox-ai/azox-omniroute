# Upstream Synchronization

Upstream repository: `https://github.com/diegosouzapw/OmniRoute`

GitHub development fork: `https://github.com/azox-ai/azox-omniroute`

Company distribution: `https://zalogit2.zing.vn/ai-devops/innovation/llm-gateway/omniroute`

## Branch Model

- `main`: reviewed company distribution; protected in GitLab.
- `upstream/<version>`: optional immutable upstream import point.
- `fix/<scope>`: company patch or upstream contribution branch.

Do not mirror every upstream branch into GitLab. Import only the baseline and
branches needed for an active company release.

## Upgrade Procedure

1. Fetch the latest upstream release branch and tag.
2. Review release notes, migrations, dependencies and Docker changes.
3. Create a branch from the new upstream release.
4. Check whether each entry in `CUSTOMIZATIONS.md` is already included.
5. Drop patches already shipped upstream; replay only remaining changes.
6. Run focused tests, full typecheck, build and migration rehearsal.
7. Deploy to a canary or cloned production volume.
8. Merge through GitLab merge request.
9. Create a `zad-zbs-fiza-` release tag.
10. Publish the immutable company container image and record rollback evidence.

## Remote Setup

Recommended local remotes:

```text
origin   -> zalogit2 company distribution
github   -> azox-ai/azox-omniroute
upstream -> diegosouzapw/OmniRoute
```

Never place access tokens in Git remote URLs committed to disk, CI output,
issues, merge requests or documentation. Use Git credential helpers, protected
CI variables, deploy tokens or SSH keys.

