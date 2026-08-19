# Next Level BMX — Team Hub

Mobile web app for the Next Level BMX team. Asana is the backend; Vercel hosts it.

---

## Deploy (one time)

### 1. Push to GitHub
Create a new repo (e.g. `nlbmx-team-hub`), then from this folder:

```bash
git init
git add .
git commit -m "Initial Team Hub build"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/nlbmx-team-hub.git
git push -u origin main
```

### 2. Import into Vercel
- vercel.com → **Add New… → Project** → pick the repo
- Framework preset: **Other**. Leave build settings empty.
- Before clicking Deploy, add the environment variables below.

### 3. Environment Variables
In Vercel → Project → Settings → **Environment Variables**:

| Name | Value |
|---|---|
| `ASANA_TOKEN` | Your Asana personal access token |
| `SESSION_SECRET` | Any long random string you invent |
| `HUB_PROJECT_GID` | `1217616477503428` |

The token is read only on the server. It never reaches the browser.

> **Generate a fresh token** rather than reusing one that's been pasted into a chat
> or email. Asana → profile photo → Settings → Apps → Manage Developer Apps.

### 4. Make yourself admin
After you sign up in the app once:
1. Open the Asana project → **Riders** or **Parents & Guardians** section
2. Find your task, open it
3. Add this line to the description: `IS_ADMIN: true`
4. Sign out and back in — an **ADMIN** tile appears on your home screen

---

## How the Asana backend works

Project: **Next Level BMX - Team Hub**

| Section | Holds |
|---|---|
| Riders | One task per rider — profile, form status, signature |
| Parents & Guardians | One task per parent account |
| Tile Config | One task per home-screen tile |
| Sign-Up Events | One task per race; subtasks are the claimable items |
| App Config | Season dates, fee, GroupMe bot ID |

Data lives in each task's **description**, one `KEY: value` per line. Edit in Asana
and the app picks it up on next load — no redeploy.

### Tile fields
```
ICON_URL: https://…      (public image link; blank = built-in icon)
LINK: https://…          (where the tile opens)
VISIBILITY: public       (or "admin" to hide from riders/parents)
ORDER: 3                 (lower numbers appear first)
```

Gear Ordering also uses `SUBLINK_GEAR`, `SUBLINK_JERSEYS`, `SUBLINK_PLATES`.

### Custom icons
Icons must be at a **publicly viewable URL**. Asana attachment links require a
login, so upload to Google Drive instead:
1. Upload the image to Drive
2. Share → **Anyone with the link → Viewer**
3. Copy the file ID from the URL
4. Use `https://drive.google.com/uc?export=view&id=FILE_ID` as `ICON_URL`

Recommended icon size: **240×240px**, transparent PNG.

---

## Still to wire up

- **Gear + Jerseys links** — paste into the Gear Ordering tile in Asana when the
  vendor confirms. Plates link is already in.
- **Race Stats / Files tiles** — add the Google Drive links in Asana.
- **Day-before reminders** — email + GroupMe bot post. Needs a Vercel Cron job
  and a Gmail app password; not built yet.
- **Signed PDF copies** — emailing a PDF of each signed agreement. Not built yet.

---

## Notes

- Sessions persist until the user signs out. Shared devices will stay signed in
  as whoever logged in last, by design.
- Minors (under 18, Rider role) never see the Team Forms banner — only parents
  and 18+ riders can sign.
- Parent signup fuzzy-matches rider names. Close-but-inexact matches are written
  to the rider's `PENDING_MATCH` field and surface in the Admin screen for you
  to resolve manually in Asana.
