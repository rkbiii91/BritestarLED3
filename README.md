# Brite Star LED — Contractor Install Report

Contractors open the link (no login with any outside service), pick their job site, enter the site
password, and log fixtures. When they tap **Submit report**:

1. The report is saved on the server (shows up in your **Admin dashboard**).
2. An email is sent **from britestarledev@gmail.com to rb@britestar.com, care@britestar.com and rk@britestar.com** with the full report
   (location, area, contractor, date, every fixture with qty / color / wattage / note) and a CSV attached.

Everything else (add/remove locations, per-location fixture and area types, per-submission CSV
download and delete, grouped-by-location view) works as before, at `your-url/` → "Admin dashboard".

---

## 1. Put the code on GitHub

1. github.com → **New repository** → name it `brite-star-install-report` → Private is fine → Create.
2. On the empty repo page click **uploading an existing file**.
3. Unzip this package and drag in **everything inside the folder**: `server.js`, `package.json`,
   `render.yaml`, `README.md`, `.gitignore`, `.env.example`, and the `public` folder (with `index.html`).
   Do NOT upload `node_modules` or `data` if you ever see them.
4. **Commit changes**.

## 2. Create the service on Render

1. dashboard.render.com → **New +** → **Web Service** → connect the GitHub repo.
2. Settings:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** **Starter ($7/mo)** — recommended (see "Free vs. Starter" below)
3. **Advanced → Add Disk** (Starter only): Name `data`, Mount Path `/var/data`, Size `1 GB` (~$0.25/mo).
4. **Environment Variables** (Add each one):

| Key | Value |
|---|---|
| `DATA_DIR` | `/var/data`  (only if you added the disk) |
| `ADMIN_PASSWORD` | `BritestarLED2026!` |
| `MAIL_TO` | `rb@britestar.com, care@britestar.com, rk@britestar.com` (comma-separated; add or remove people here anytime) |
| `MAIL_FROM` | `britestarledev@gmail.com` |
| `DISPLAY_TZ` | `America/New_York` (time zone used in emails) |
| plus the email credentials from step 3 below | |

5. **Create Web Service**. When it says "Live", your URL is `https://<name>.onrender.com`.

(Shortcut: **New + → Blueprint** reads `render.yaml` and sets the Starter + disk + variables for you; it
will prompt for `ADMIN_PASSWORD` and `GMAIL_APP_PASSWORD`.)

## 3. Connect the Gmail account (pick ONE option)

### Option A — Gmail app password (simplest; REQUIRES a paid Render instance)
Render blocks outbound SMTP ports (25/465/587) on free web services, so this only works on Starter or higher.

1. Sign in to **britestarledev@gmail.com** → myaccount.google.com → **Security**.
2. Turn on **2-Step Verification** if it isn't already.
3. Go to **myaccount.google.com/apppasswords**, name it `Render install report`, click **Create**.
4. Copy the 16-character password.
5. In Render add env var `GMAIL_APP_PASSWORD` = that password (spaces don't matter).

### Option B — Gmail API over HTTPS (works on the FREE Render plan, more setup)
1. Sign in to **console.cloud.google.com** as britestarledev@gmail.com → project picker → **New Project**
   → name `Brite Star Install Report` → Create.
2. **APIs & Services → Library** → search **Gmail API** → **Enable**.
3. **APIs & Services → OAuth consent screen** (may be labeled **Google Auth Platform**) → **Get started**:
   app name `Brite Star Install Report`, support email = britestarledev@gmail.com, **Audience: External**,
   contact email = britestarledev@gmail.com → Create.
4. **Data Access** (or "Scopes") → **Add or remove scopes** → add
   `https://www.googleapis.com/auth/gmail.send` → Update → Save.
5. **Audience** → **Publish app** → confirm so the status reads **In production**.
   **Do not skip this** — in "Testing" status Google expires the refresh token after 7 days and emails silently stop.
6. **Clients** (or **Credentials → Create credentials → OAuth client ID**) → type **Web application** →
   Authorized redirect URI: `https://developers.google.com/oauthplayground` → Create →
   copy the **Client ID** and **Client secret**.
7. Open **developers.google.com/oauthplayground** → click the **gear icon** (top right) → tick
   **Use your own OAuth credentials** → paste Client ID and Secret.
8. Step 1 (left panel): in the "Input your own scopes" box type
   `https://www.googleapis.com/auth/gmail.send` → **Authorize APIs** → sign in as britestarledev@gmail.com.
   You'll see "Google hasn't verified this app" → **Advanced → Go to Brite Star Install Report (unsafe)** → Allow.
9. Step 2: **Exchange authorization code for tokens** → copy the **Refresh token**.
10. In Render add env vars: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`.

Note: changing the Gmail account's password revokes the refresh token; repeat steps 7–10 if that happens.

## 4. First-time setup and test

1. Open your Render URL → **Admin dashboard** (bottom of the first screen) → sign in with `ADMIN_PASSWORD`.
2. **Locations** → add each job site and the password you'll give that site's contractors.
3. **Fixture Types** / **Area Types** → pick a location and edit its lists.
4. Back out, tap **Start report**, submit a test report, and confirm:
   - the email arrives at all three recipient inboxes (check Junk/Spam the first time and mark it "not junk"),
   - the report appears in **Admin → Submissions**.
5. Delete the test submission, then send contractors the URL (or a QR code of it).

If a report ever shows an **"email not sent"** tag in the admin list, the report is still saved — check the
Render **Logs** tab for the reason (usually expired token or wrong app password).

## Free vs. Starter (what to expect)

| | Free | Starter ($7/mo) + 1 GB disk (~$0.25/mo) |
|---|---|---|
| Contractor can submit | yes | yes |
| Email via Gmail API (Option B) | yes | yes |
| Email via app password (Option A) | **no (SMTP blocked)** | yes |
| Locations, passwords, saved submissions survive restarts/redeploys | **no** (local files are wiped) | **yes** (on the disk) |
| First load after 15 min idle | slow (~30–60 s wake-up) | instant |

On Free, every submission still arrives by email, but locations/fixture lists/admin password changes
reset whenever the service restarts or redeploys, so you'd be re-adding them. Starter + disk avoids that.

## Changing the app later

Edit the files in GitHub (`public/index.html` is the screen; `server.js` is the backend). Render redeploys
automatically on every commit. Data on the disk is untouched by redeploys.

## Local testing (optional)

```
npm install
EMAIL_DRY_RUN=1 npm start     # writes the email to data/last-email.eml instead of sending
```
