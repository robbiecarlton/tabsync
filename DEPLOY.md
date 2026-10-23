# Deploying to Railway

How to run the sync server on [Railway](https://railway.com) with Railway Postgres, and point
the extension at it. This is milestone 6 in `PLAN.md`.

The server is one stateless Node process: a Postgres database plus one service built from this
repo. The service builds from the **repo root**, because the server bundles `shared/`.

## 1. Create the project and database

1. In Railway, click **New Project** → **Deploy from GitHub repo** and pick this repo.
   (Push it to GitHub first if you haven't.)
2. In the same project, click **New** → **Database** → **Add PostgreSQL**. Railway calls the
   database service `Postgres`.

## 2. Configure the server service

Open the service created from the repo, then its **Settings** tab.

| Setting                       | Value                                  |
| ----------------------------- | -------------------------------------- |
| Source → Root directory       | _(leave empty: the repo root)_         |
| Build → Custom build command  | `npm run build -w server`              |
| Deploy → Pre-deploy command   | `npm run migrate:prod -w server -- up` |
| Deploy → Custom start command | `npm start -w server`                  |
| Deploy → Healthcheck path     | `/health`                              |

Railway installs dependencies (`npm ci`) before the build command. The pre-deploy command
runs the database migrations before each new version starts, so a failed migration stops the
deploy and the previous version keeps running.

## 3. Set variables

In the server service's **Variables** tab, add:

| Variable        | Value                        | Why                                                  |
| --------------- | ---------------------------- | ---------------------------------------------------- |
| `DATABASE_URL`  | `${{Postgres.DATABASE_URL}}` | Railway's reference to the database's private URL    |
| `TRUST_PROXY`   | `1`                          | Read the client IP and protocol from Railway's proxy |
| `REQUIRE_HTTPS` | `1`                          | Refuse requests that arrived over plain HTTP         |

Don't set `PORT`: Railway provides it. `ALLOWED_ORIGINS` isn't needed either, because the
extension reaches the server through its host permission, not CORS.

## 4. Get a public URL and deploy

1. Go to **Settings** → **Networking** → **Generate Domain**. You'll get something like
   `https://tabsync-production-ab12.up.railway.app`.
2. Deploy, or wait for the automatic deploy. In the deploy logs you should see `Applied:
0000_init` from the pre-deploy step, then `tabsync server listening on …`.
3. Check it:

   ```sh
   curl https://<your-domain>/health
   # {"status":"ok"}
   ```

## 5. Point the extension at it

**Quick way (no code change):** on each device, open the extension's options page, set
**Server URL** to `https://<your-domain>` and click **Save**. Brave asks for permission to
reach that site; allow it.

**Permanent way (milestone 6 code change):** tell me the domain. I'll make it the default
server URL and add it to the manifest's `host_permissions`, so new installs need no setup.

### Moving existing devices over

Profiles live on the server, so your local dev server's profile doesn't exist on Railway. A
secret from the local server will fail to join there ("No sync profile found"). To move over:

1. **First device:** options → **Disconnect**, set the Railway server URL, then **Create new
   sync profile**. Save the new secret in your password manager.
2. **Every other device:** options → **Disconnect**, set the Railway server URL, then **I have
   a secret** with the new secret, then **Apply** in the popup.

## 6. Two-machine test

Run the testing checklist in `SPEC.md` ("Edge cases and testing checklist") on two real
machines. The items that can only be checked this way:

- Browser closed mid-push: the pending snapshot pushes on next start.
- Browser restart: session restore settles without a spurious push.
- Server unreachable (e.g. turn off Wi-Fi): Pending, then Error after 5 minutes, then
  recovers on its own.
- Clock skew: set one machine's clock a few minutes off; ordering still works.
- 200+ tabs: apply stays responsive and new tabs open unloaded.
- Behind → Apply, conflicts (Merge / Keep mine / Take theirs), and history restore + undo.

## Operations

- **Logs:** the service's **Deployments** → **View logs**. The daily retention sweep logs
  `daily sweep pruned N snapshots` when it deletes anything.
- **Redeploy:** pushing to the default branch redeploys automatically; migrations run first.
- **Rolling a migration back:** use the Railway CLI from your machine with the database's
  _public_ URL (the private one only resolves inside Railway):

  ```sh
  railway link                                   # once, pick the project
  railway variables --service Postgres           # copy DATABASE_PUBLIC_URL
  npm run build -w server
  DATABASE_URL='<DATABASE_PUBLIC_URL>' npm run migrate:prod -w server -- down
  ```

  Then redeploy a version whose migrations match.

- **What the server can see:** profile IDs, timestamps, blob sizes and request timing. It
  can't see URLs, titles, groups or device names: everything else is encrypted in the
  extension.
