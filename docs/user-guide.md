# ORtoolbox user guide

ORtoolbox is a set of 14 AI tools that runs in your browser on your own [OpenRouter](https://openrouter.ai) key. This guide covers setup, each tool, the platform pages and what to do when something goes wrong. The site is at <https://ethanpil.github.io/or-toolbox/>.

**Contents**

- [First steps](#first-steps)
- [Using a tool](#using-a-tool)
- [The tools](#the-tools): [Chat](#chat) · [OCR](#ocr) · [Data extractor](#data-extractor) · [Table extractor](#table-extractor) · [Speech-to-text](#speech-to-text) · [Text-to-speech](#text-to-speech) · [Music generation](#music-generation) · [Image generation](#image-generation) · [Image editor](#image-editor) · [Isolated image](#isolated-image) · [Video studio](#video-studio) · [Decision](#decision) · [Bot-to-bot chat](#bot-to-bot-chat) · [Model arena](#model-arena)
- [The platform pages](#the-platform-pages): [Home](#home) · [Models](#models) · [History](#history) · [Stats](#stats) · [Settings](#settings) · [Backup and restore](#backup-and-restore) · [Privacy](#privacy) · [Diagnostics](#diagnostics)
- [Troubleshooting](#troubleshooting)
- [Browser support](#browser-support)

## First steps

### 1. Add an OpenRouter key

Every model call is paid for with your own OpenRouter key, so you need one before a tool can run. Add it in the setup wizard on Home, in **Settings → Keys**, or in the "Add an OpenRouter key" dialog that a tool opens when it finds none. There are two ways:

- **Connect with OpenRouter.** Press the button. The browser goes to openrouter.ai, you approve, and OpenRouter creates a key for this browser and sends you back. Nothing to copy.
- **Paste a key.** Paste an existing key (it starts with `sk-or-`) into "Paste an OpenRouter API key" and press **Save key**. ORtoolbox checks the format, saves it, then asks OpenRouter whether it works. A key OpenRouter rejects is removed again.

Tip: use a key with a **credit limit**. Create one at [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) and paste it; if it ever leaks, it can only spend that much. A key made by "Connect with OpenRouter" can be given a limit afterwards in the same key list.

You can keep several keys ("Work", "Free sandbox"). Settings → Keys shows each one masked (`sk-or-…a1b2`) with its balance at OpenRouter, and lets you **Rename** it, give it a color, **Make default**, or **Remove** it (an Undo toast follows). The first key you add is the default. A tool can pin its own key (see [Tool bindings](#settings)); with more than one key, a key chip in every tool's header lets you switch.

Each key has the switch "Prefer providers that do not retain data". With it on, requests made with that key ask OpenRouter to use only providers that do not store or train on your data. It is not applied to free models (they would fail) or to image and video generation.

### 2. Optional: lock your keys with a passphrase

By default your keys sit in this browser's storage unencrypted. **Settings → Passphrase lock → Turn on the lock** encrypts them with a passphrase you choose (AES-GCM, with the key derived by PBKDF2 at 600,000 rounds). You unlock once per tab; closing the tab, **Lock now**, or **Auto-lock after** (15 minutes by default, 0 for never, at most 1,440) locks them again.

- A forgotten passphrase cannot be recovered. You would remove your keys and add them again (they keep working on OpenRouter).
- The lock encrypts keys only. History, prompts and settings stay unencrypted.
- When locked, a tool that needs a key asks you to unlock first. The navbar has a lock button (**Lock keys now** / **Unlock keys**).

On `ethanpil.github.io`, every project site shares one origin, so another page on that address could read what ORtoolbox stores. The lock keeps keys encrypted there. See [Privacy](#privacy).

### 3. Optional: free-only mode

**Settings → Default models → Free-only mode** (also offered in the setup wizard as "Use free models only") makes ORtoolbox use free models only, so nothing you run can cost money. While it is on:

- A "Free only" badge shows in the navbar.
- Each capability switches to its best free model; model pickers hide paid ones; a run that would use a paid model is refused.
- Tools whose capability has no free model cannot run and say so ("This tool cannot run in free-only mode"). At release there is no free model for image generation, speech-to-text, music or video. So [Image generation](#image-generation), [Image editor](#image-editor), [Isolated image](#isolated-image), [Speech-to-text](#speech-to-text), [Music generation](#music-generation) and [Video studio](#video-studio) are blocked. Chat, OCR, the extractors, Text-to-speech, Decision, Bot-to-bot chat and Model arena have free models. The Settings page lists what is blocked right now.
- Paid add-ons are refused too, for example the paid PDF readers.

Free models are rate-limited: 20 requests per minute, and a daily quota (50 requests a day, or 1,000 once your OpenRouter account has bought $10 of credits). ORtoolbox queues requests beyond 20 a minute rather than failing them. Settings shows how many free requests you used today. Free providers often log prompts or train on them; do not send anything private to a free model.

### 4. Budgets and cost estimates

**Estimates.** Next to the model chip, every tool shows a pill with the estimated cost of the next run: `≈ $0.0012`, `Free` or `Unknown`. It updates as you change the input. Estimates are rough and deliberately err on the high side. The real cost, reported by OpenRouter, is recorded after the run and shown in History.

**Budgets.** **Settings → Budgets** has three modes:

| Mode | What it does |
| --- | --- |
| Disabled | No checks. Runs never ask and are never stopped. |
| Warn | Asks before a run that would pass a limit or the per-run threshold. |
| Hard stop | Blocks runs that would pass a monthly limit. Still asks above the per-run threshold. |

The default is **Warn** with a **per-run threshold** of $0.10 (set it to 0 to be asked before every paid run). You can also set a **monthly limit for the whole app** and a **monthly limit per key**, each with a meter. Months follow UTC.

When a run needs your approval, a dialog ("Confirm this run") shows the estimate, the limit and the model, with **Run anyway**, Cancel and a link to **Change your budgets**. Several runs started with one action (a Model arena round, a Video studio sequence) ask once, for their total.

Budgets count what you spent in this browser (the local ledger written when runs finish), not OpenRouter's balance, which lags. A run whose cost could not be read counts at its reserved estimate. Runs on free models are not checked.

### 5. Try a tool

The Home page offers a three-step wizard: connect, pick favorite tools, **Try a sample**. A sample opens a tool with an example already filled in. Press its run button (Send, Generate, Transcribe and so on). Skip the wizard any time with **Skip setup**; add a key later in Settings → Keys.

## Using a tool

All 14 tools share one layout.

- **Header.** The tool's name, then **Prompts**, **Settings** and **History** buttons. Below: the **model chip** (click it to pick another model; it shows the price, or "Free"), a **key chip** when you have more than one key, and the **cost estimate** pill. A model you pick here is remembered for that tool.
- **Input** on the left, **Output** on the right (they stack on narrow screens). The **Settings** button opens a side drawer with the tool's options. Some tools add a collapsed accordion section at its end, titled for its purpose (for example "Long recordings").
- **Run button.** Sticky at the bottom of the input zone. Press **Ctrl+Enter** (**Cmd+Enter** on a Mac) from anywhere on the page. While a run is going the button reads "Running…" and a red **Stop** appears. Chat and Bot-to-bot chat also stop on **Esc**.
- **Files.** Drag files onto any tool, or paste them. A tool takes only the types it supports and tells you what it skipped. Many tools have a drop zone with a "Choose a file" button too.
- **Sample.** Opening a tool with `?sample=1` in the address fills an example without running it.

### Results and the leave warning

Text results (replies, transcripts, extracted JSON) go to [History](#history). **Images, audio, video and uploaded files are never stored.** They live in memory while the page is open. If you try to leave with results you have not downloaded, a dialog lists what you would lose and offers **Download all** (a ZIP), **Stay** or **Leave anyway**. Reloading or closing the tab triggers the browser's own prompt. Download what you want to keep.

### Send to…

Result cards have a **Send to…** button. It lists the other tools that accept the result (an image goes to Image editor, Isolated image, OCR and others; text goes to Chat, Text-to-speech and others). The target opens in a new tab with the result already in it. Nothing is stored in between.

### Prompts: Recent and Saved

The **Prompts** button opens a panel with two tabs.

- **Recent** fills automatically from your runs in that tool.
- **Saved** holds what you chose to keep. **Save current** stores the prompt together with the tool's current settings (voice and format for Text-to-speech, aspect ratio for images, and so on). **Use** restores both.
- Per prompt: **Use**, **Save** (from Recent), **Rename**, **Copy**, **Delete**. A menu offers **Clear recent**, **Clear saved** and **Clear all for this tool**. Deletes ask first and offer Undo.
- Saved prompts never expire. Recent ones follow your history retention. **Settings → Data → Record recent prompts** turns auto-recording off.

### When something is refused

You do not handle most problems by hand: the tool shows what is needed.

- No key: a dialog to connect or paste one.
- Keys locked: the unlock dialog.
- Free-only mode with a paid model: a message to pick a free model or turn the mode off.
- A hard budget block: a message naming the limit, with a link to Settings → Budgets.
- A paid request that **may have been billed** (connection lost after sending, an error such as 5xx): the toast "This may have gone through" with a link to [OpenRouter activity](https://openrouter.ai/activity) instead of a plain Retry. Check there before sending again.

### Keyboard

| Keys | Does |
| --- | --- |
| Ctrl/Cmd+K | Opens the command palette: jump to a tool, page, settings section, recent run or model, switch theme, lock keys |
| `/` | On Home, focuses the tool search |
| Ctrl/Cmd+Enter | Runs the tool |
| Esc | Stops a run in Chat and Bot-to-bot chat (and closes dialogs) |

Everything is reachable with the keyboard, focus is always visible, and status changes are announced to screen readers. Animations and page transitions switch off with your system's reduced-motion setting or **Settings → Appearance → Reduce motion**.

## The tools

Each section lists what goes in, the main options, what comes out and the limits worth knowing. Every tool also has the shared header, drawer and Run button described in [Using a tool](#using-a-tool).

### Chat

Talk to any text model. Attach files and images, branch a conversation by editing or regenerating, and switch models between messages.

**Input**
- Type in "Message" and press **Send**. Enter sends and Shift+Enter adds a line (you can turn this around in Settings). Ctrl/Cmd+Enter always sends. The Up arrow in an empty box edits your last message. Esc stops a reply.
- Add files with **Attach**, by dropping them on the page or by pasting. Up to 10 files per message:

| Type | Limit |
| --- | --- |
| Images (PNG, JPEG, WebP, GIF) | 10 MB each |
| PDF | 25 MB |
| Audio | 25 MB |
| Text and code files | 1 MB each, 2 MB per message |

- The model must be able to read what you attach. If it cannot, the box warns you (for images it offers a button to switch to a vision model) and a send is refused.
- The button above the box shows the model this chat uses ("(default)" means it follows the model chip in the header). Pick another one there and the next message uses it; the **x** next to it goes back to the default. Each reply is labeled with the model that wrote it.

**Branches**
- **Edit** on one of your messages opens an editor; **Save and send** sends it as a new branch and keeps the original. Regenerate on a reply does the same for the answer. Use the arrows with "n/m" to move between versions. What you see, send and export is the branch you are on.
- **Delete this and what follows** asks first and offers Undo.
- The **Threads** panel lists your chats with **New chat**, a search box ("Search titles and messages"), rename and delete. Chats are saved in this browser (text only) and stay in step across tabs.

**Settings drawer**
- **System prompt**, per chat, with an "Insert a preset…" list (Concise, Patient teacher, Senior engineer, Editor, Translator).
- **Temperature** and **Max tokens** (empty means the model's default; Max tokens is trimmed to what the model and its context allow).
- **Reasoning effort** (only for models that support it) and the switch **Show reasoning when the model returns it**.
- **Enter sends (Shift+Enter for a new line)**.
- Section **Fallbacks and PDFs**: up to five **Fallback models** that OpenRouter tries in order if the first fails (the reply says which one answered; the estimate assumes the dearest), and the **PDF reader**: "Cloudflare AI (free)" (default), "Mistral OCR (paid per page)" or "The model's own PDF reading".

**Output**
- **Copy** puts the whole conversation on the clipboard as Markdown. **Export** downloads **Markdown** or **JSON** of the branch you are on. Attachments appear by name; their contents are not exported.
- Each message has Copy, and code blocks have their own "Copy code".
- A failed reply shows **Retry** and **Retry with another model**. If it may have been billed, it links to OpenRouter activity instead of Retry.
- History gets one entry per send, edit or regenerate (text only).

**Limits and tips**
- Images, PDFs and audio are kept in memory only. After a reload, earlier messages show "Attachment not kept after reload" and the model gets a one-line note instead. Text files, and the text of a PDF that was already read, survive.
- A PDF is read once: the first turn runs the PDF reader, later turns send the extracted text.
- If a message does not fit the model's context window it is refused; in a long chat, the oldest messages are left out and the reply says so.
- In free-only mode a chat whose model is not free is refused until you pick a free one ("Use the default").

### OCR

Turn images and PDFs into text, including handwriting and math.

**Input**
- Drop or choose PNG, JPEG, WebP and PDF files. Mix as many as you like; every selected page becomes one request.
- For a PDF, the "Pages" box takes ranges such as `1-3, 7`, `5-` or `all`. **All** and **None** are shortcuts, and **Choose pages** opens a grid of page thumbnails. Pages are only rendered when their request starts, so a long PDF does not fill memory.
- **Mode**: "Printed text" (default), "Handwriting", "Math" (formulas as LaTeX in Markdown) or "Layout-preserving" (columns and tables kept, tables as Markdown).
- **Extra instructions (optional)**, for example "skip the page headers".

**Settings drawer**
- **Language hint**.
- **Page separators**: start every page with a line naming it in the combined text (on).
- **Send the PDF's own text along**: where a PDF page already has text, the model gets it as a spelling hint (on).
- **PDF parser**: the switch "Use OpenRouter's PDF parser instead" sends each PDF whole (the page selection is ignored). **Parser**: "Cloudflare AI (free)", "Mistral OCR (paid per page)" or "The model's own PDF reading".
- Section **Images and speed**: **Page image size (longest side)** (1024, 1600 or 2048 px) and **Pages read at the same time** (1 to 3).

**Output**
- Press **Read**. Text streams in. Switch the **View** between "Combined" and "By page"; each page shows its own status and a **Retry** when it failed or was not read.
- **Copy**, **Download** as Markdown, Plain text or Word document, and **Send to…** (Chat, Model arena, Decision, Text-to-speech).
- A failed page never stops the others. "N pages not read" offers one Retry for all of them; a retry is a new run with its own estimate.

**Limits and tips**
- A page answer is cut at 4,096 tokens (a whole-PDF answer at 32,000). The page is then flagged "cut off".
- Mistral OCR is billed per page by OpenRouter, even with a free model, at about $2.20 per 1,000 pages; the estimate counts every page of each PDF. Free-only mode refuses it. Keep "Cloudflare AI (free)" for PDFs that already contain text.
- Press Read again and the previous result is replaced. Stop keeps the text read so far.

### Data extractor

Pull structured fields out of invoices, receipts and other documents, review them in a grid and export.

**Input**
- Drop images or PDFs. Each file is one document, one row. A PDF over 20 selected pages is split into 20-page chunks, each its own row. The switch **One extraction per page** (drawer) makes every page its own document, for a scanned stack of receipts.
- **Fields to extract**: pick a preset or one of your saved sets.
  - **Invoice / receipt** (default): vendor, invoice number and dates, currency, subtotal, tax, total, payment method and line items.
  - **Purchase order**, **Business card**, **Resume**, **Bank statement lines**.
  - **Edit fields** opens the builder: **Add field** with a name, a type ("Text", "Number", "Currency amount", "Date", "Yes / no", "Choice", "List of text", "Table of line items"), **Required**, a description the model reads, and for tables their columns. **Save as…** keeps a set; **Rename** and **Delete** manage saved ones.
- **Extra instructions (optional)**, for example "amounts are in Swiss francs".

**Settings drawer**
- **One extraction per page**, **Send the PDF's own text along**, and under **Images and speed**: page image size and **Documents at the same time** (1 to 3).

**Run and review**
- Press **Extract**. One row per document appears with a status ("Extracting…", "Done", "Failed"). The summary line counts documents extracted, to check, corrected and failed.
- Every cell is editable. Entries are understood and tidied as you leave the cell (`1.234,56`, `(12.00)`, dates to `YYYY-MM-DD`, yes/no words, choices). A doubtful value stays as typed and is flagged in the **Check** column, never silently changed.
- A table field shows a button "N rows" that opens a nested grid you can edit, with **Add row**. **Source** opens the page image the row came from.
- Failed rows have **Retry**; **Retry failed** retries all of them.

**Output**
- The **Download** menu offers **JSON**, **CSV** (documents, one per table field, and one row per line item) and an **Excel workbook**. Only documents that finished are exported, with your corrections.
- The workbook has a "Documents" sheet and one sheet per table field, keyed by document number. Currency columns are numbers formatted `#,##0.00`, and dates are real dates.
- There is no Copy or Send to… here. History keeps the extracted JSON as it was when the run ended; later corrections are not in History.

**Limits and tips**
- The tool asks the model for a strict JSON schema when it supports that, plain JSON mode otherwise, and falls back by itself if no provider can serve the strict request. An answer that cannot be read gets one repair attempt, then the row fails.
- Press **Extract** again and the whole grid, with your corrections, is replaced without asking. Export first.
- Removing a file from the list later disables **Source** and Retry for its rows.

### Table extractor

Find tables, and optionally charts, in pages and turn them into editable grids you can export.

**Input**
- Drop PNG, JPEG, WebP or PDF files and choose pages the same way as in OCR. Every selected page is one request.
- The checkbox **Also turn charts into tables of their data** is on by default.
- **Extra instructions (optional)**, for example "only the table about 2025".

**Settings drawer**
- **Send the PDF's own text along** and, under **Images and speed**, **Page image size (longest side)** (default 2048 px; dense tables need a large image) and **Pages read at the same time**.

**Run and edit**
- Press **Find tables**. The summary reads "N tables · M rows · X of K pages read". Every table is a card with an editable title, editable headers and cells, a "From a chart" badge where it came from a chart, and a note about where it was found.
- Per card: **Add row**, add or remove columns and rows, **Copy for a spreadsheet** (tab-separated, paste straight into a spreadsheet), **Merge with next page** (for a table that continues on the next page; a repeated header row is dropped) and **Delete table** (with Undo).
- The grid is one Tab stop; arrow keys move between cells.
- A page that could not be read is listed with one **Retry**. A page whose answer hit the length limit is flagged because its last rows may be missing.

**Output**
- **Download**: **CSV** (one table), **CSV files (ZIP, one per table)**, **Excel workbook (a sheet per table)** or **Markdown**. Edits are included.
- Numbers that are plain numbers as printed become numeric cells; identifiers such as phone numbers and codes with leading zeros stay text.
- History keeps the tables as Markdown as they were when the run ended.

**Limits and tips**
- Pressing **Find tables** again clears all tables and edits without asking.
- A page with no tables is not an error; the status says "no tables found".

### Speech-to-text

Transcribe recordings and uploads of any length, with timestamps, subtitles and an editor.

**Input**
- **Record** with your microphone (the browser asks for permission the first time): **Record**, **Pause**/**Resume**, **Stop recording**, with a level meter and, with several microphones, a "Microphone" picker. A recording can last 2 hours. It stays in this tab until you press "Download recording".
- Or drop one audio or video file (MP3, WAV, M4A, OGG, WebM, FLAC, MP4 and others; a video's sound track is used). If you drop several, the first is used.
- **Vocabulary (optional)**: names and terms to spell right, separated by commas. Only Deepgram and AssemblyAI models take it; for other models the note says it is not sent.

**Settings drawer**
- **Language**: "Detect automatically" or one of 44 languages.
- **Timestamps** (on) and **Speaker labels** (off). A switch the chosen model cannot honor shows off and disabled, with the reason, and your choice comes back on a capable model. GPT-4o transcribe and MAI-Transcribe 1.5 give no timestamps; speaker labels need a Deepgram or MAI-Transcribe model that also gives timestamps.
- Section **Long recordings**: **Longest part** (1, 2, 5 or 8 minutes; default 5).

**How long recordings work**
- A short file in a format the API reads goes as it is, in one request. Anything else (long audio, video, other formats) is decoded in the browser to 16 kHz mono and cut at pauses into parts. If the browser cannot decode a file, ffmpeg (about 32 MB, downloaded once) does it.
- Two parts are transcribed at a time. At each seam, repeated words are removed and times continue without a jump. A part that fails is marked and **never retried automatically**; **Retry** (on the part or on the notice) is a new run for just those parts.
- Speaker labels are per request, so a long recording numbers its speakers again in each part. Give the same person the same name in each part.

**Output**
- Press **Transcribe**. The **editor** has a "Segments" and a "Text" view, a search box, and a **Follow playback** switch. Each segment has a time button that plays from there and a text box you can correct. A **Speakers** group lets you name speakers.
- **Copy** gives plain text. **Download**: **Text** (.txt), **Subtitles (SRT)** and **Subtitles (WebVTT)** (only when every part has times), **JSON (segments and words)** and **Word document**. **Send to…** sends the text.
- History keeps the transcript text. Audio, edits and speaker names are memory only.

**Limits and tips**
- There is no file-size cap in the tool; browser memory is the limit.
- AssemblyAI models take at most 110 seconds per request, so parts are shorter for them.
- Free-only mode blocks this tool (no free transcription model).

### Text-to-speech

Read text aloud in a chosen voice, stitched into one audio file.

**Input**
- Type or paste in "Text", or drop `.txt` and `.md` files (they are appended; Markdown is turned into plain text). The line under the box counts characters, words and requests.
- **Voice** with a **Preview** button that reads one short sentence in that voice. A preview is a real, tiny run: it costs a little (the note says how much), is cached for the visit and appears in History.

**Settings drawer**
- **Audio format**: "MP3 (smaller)" (default) or "WAV (uncompressed)". Both can be downloaded afterwards.
- **Speed** (0.5 to 2): shown only for models that take it (for example Kokoro).

**How it works**
- Press **Read aloud**. The text is cut into pieces of about 60 seconds of speech at paragraph, sentence and clause boundaries, never mid-word if it can be avoided. Three pieces are made at a time, then all pieces are joined into one file with no gaps (this uses ffmpeg, downloaded once, for MP3).
- If pieces fail or you press Stop, the finished ones are kept and a notice offers **Retry N parts** or **Make the other N**: a new run for just those. Pieces are never retried automatically. Pressing **Read aloud** again with the same text, model, voice and speed continues the same plan; changing any of them starts a new plan and drops un-joined pieces.

**Output**
- Each finished file is a card with a waveform player, **Download** (MP3 and WAV), **Send to…** and **Remove** (which does not ask).
- History keeps the text and settings; audio is memory only.

**Limits and tips**
- The estimate uses the dearest provider's price for the model, so it errs high.
- Fish Audio's free model is the only free speech model at release.

### Music generation

Compose songs and instrumentals with Google's Lyria models.

**Input**
- **Describe the music**, plus **Genre**, **Mood**, **Tempo** (a bare number such as `120` becomes "120 BPM") and **Instruments**.
- **Vocals** or **Instrumental**. For vocals, an optional **Singing voice**. Instrumental drops the lyrics from the prompt.
- **Lyrics (optional)** with tag buttons for `[Intro]`, `[Verse]`, `[Chorus]`, `[Bridge]` and `[Outro]`. The checker blocks the run on an unclosed bracket and warns about unknown section names, empty sections and (for a Clip) lyrics past what fits in 30 seconds.
- **Length**: "Clip" (about 30 seconds, $0.04 each) or "Song" (about 3 minutes, $0.08 each).
- One optional **reference image** (PNG, JPEG or WebP) sets the mood.

**Settings drawer**
- **Variations**: 1 to 3 songs from the same form, shown side by side, each at full price.
- **Target length** (5 to 600 seconds): a longer result is cut in your browser and ends with a 2-second fade-out. Empty keeps the full length.
- Section **Prompt preview**: the exact text sent to Lyria. Lyria has no separate settings for genre or length, so the form becomes this text.

**Output**
- Press **Compose**. Variations run at the same time as one run with one budget question. Each song is a card with a waveform player, a lyrics panel (the line being sung is highlighted), **Download** (MP3 and WAV), **Send to…** and **Remove**.
- A failed variation has **Retry** (a run of one). It is not offered when Lyria declined the request, because you would be charged for the same answer.

**Limits and tips**
- Lyria always makes its own length; a target only shortens it.
- An empty form still runs ("Compose a song.") and is billed.
- Free-only mode blocks this tool.

### Image generation

Create images from a prompt, with variations and reference images.

**Input**
- **Describe the image**. Optional **Style** and **Avoid** are folded into the prompt as text (no model has a separate negative prompt, so "Avoid" is a request, not a guarantee).
- **Aspect ratio** chips, **Number of images** (1 to 4) and **Reference images** (drop, paste, **Choose files**, Send to…, or a result's **Use as reference**). Controls appear only if the chosen model supports them; references are shrunk to 2048 px and 4 MiB before upload.

**Settings drawer**
- **Resolution**, **Exact size (optional)** (`1024x1024`), **Quality**, **File format**, **Transparent background**, and **Seed** with a lock button. Unlocked, each run picks a new seed and shows it; locked, the same settings give the same picture. A model that does not list a setting never gets it.

**Output**
- Press **Generate**. Several images go as one request when the model allows `n`, otherwise as one request each (three at a time) with consecutive seeds.
- Results gather in a gallery, newest group first. Each card has a zoomable viewer, **Download** (PNG, JPG, WebP), **Send to…**, **Variations** (one new image with a new seed), **Use as reference**, **Edit** (opens Image editor) and **Remove**.
- A request that returns nothing becomes a failed card with its own **Retry**.
- History keeps the prompt and settings (with the seed) so Reopen reproduces a run. Images are never stored.

**Limits and tips**
- Free-only mode blocks this tool (no free image model).
- The estimate scales with count, size and references; an unknown or zero catalog price shows as Unknown, never Free.
- Undownloaded images trigger the leave warning.

### Image editor

Paint a mask to change, remove or extend parts of an image.

**Input**
- Drop or choose one PNG, JPEG or WebP. Pictures over 16.7 megapixels are scaled down on load.
- **Mode**: "Inpaint" (change what you paint), "Outpaint" (extend the picture outward) or "Whole image" (no mask, an instruction only). Then write the instruction in the box, whose label follows the mode.
- Inpaint: paint over the area with the **Brush**, remove paint with the **Eraser**, move around with the **Hand**. **Size** sets the brush; keys `B`, `E`, `H`, `[` and `]`, `M` (show the mask), `0` (fit) and Ctrl+Z work. Buttons: undo, redo, clear, invert, zoom. On the canvas the arrow keys move the brush, Shift+arrows paint and Enter paints a dot.
- Outpaint: choose "By margins" (Top, Right, Bottom, Left in %) or a shape such as "To 16:9". Each side of the new canvas is at most 4096 px.
- **Keep outside the mask** (on): puts your picture back pixel for pixel everywhere outside the mask, with a soft edge inside it.

**Settings drawer**
- **Soft edge**: 0 to 32 px, default 6.

**Output**
- Press **Edit**. Every edit is a new version (Version 1, 2, …); the original is "Original". Click a thumbnail to go back to that version; the next edit starts from the version on screen and nothing is overwritten. **Show before** compares a version with the one it came from.
- A version's card offers **Download** (PNG, JPG, WebP), **Send to…** and **Remove** (no confirmation).
- History keeps the instruction and settings, never the pictures.

**Limits and tips**
- The API has no mask setting. For Inpaint and Outpaint the tool sends the picture with your area tinted magenta, the plain picture and the mask, with an instruction naming each. The model decides what it changes and may also alter things outside the mask; "Keep outside the mask" repairs that afterwards.
- A model that takes fewer reference images receives fewer of these; a model that takes none cannot edit.
- While an edit runs, loading, changing versions and painting wait.
- Free-only mode blocks this tool.

### Isolated image

Put product photos on a pure white square, checked and ready for a shop.

**How it works**
- Each photo goes to an image-editing model with one fixed instruction: keep the product unchanged, remove everything else, pure white background. The tool takes no notes. In the browser it then finds the product, centers it on a square canvas with a margin, turns near-white background pixels to exactly `#FFFFFF`, optionally sharpens, and checks the result.

**Input**
- Drop up to 100 product photos (PNG, JPEG, WebP). Each is sent as a JPEG of at most the chosen size and 4 MiB.

**Settings drawer** (remembered)
- **Output size** (500 to 3000 px; default 2000), **Margin (%)** (default 8; a JPG keeps at least 24 px), **White threshold** (200 to 255; default 245), **Sharpen** and **Amount**, **Keep a soft shadow**, **Format** (JPG or PNG), **JPG quality** (default 92) and **File names** (default `{name}-white.{ext}`; `{n}` and `{size}` also work).
- Section **Requests**: **Photo size sent to the model (longest side)** (1024, 1536 or 2048 px) and **Photos edited at the same time** (1 to 3).
- Changing size, margin, threshold, sharpening, format or quality re-makes results locally, with no new request and no cost.

**Run and review**
- Press **Isolate**. It sends only photos without a result. A failed photo has **Retry** and **Another model…**; a finished one has **Review**, **Edit again** (a new paid request) and **Another model…**. **Retry failed** retries all.
- **QA** runs on the exported pixels. A photo **passes** when every border pixel is exactly `#FFFFFF` and the product touches no edge, of the square or of the model's picture. Failures say why: border pixels not white, product touching an edge, product possibly cut off by the model, a background that could not be told from the product, or JPG compression tinting the border (export PNG or use a larger margin). A failed QA never blocks the download; it asks you to look.
- **Review** shows each photo with a "Before / after" wipe or "Side by side" (to check logos and text the model may have changed), a per-photo **Margin** and **White threshold** that apply instantly, and Previous/Next.

**Output**
- Each result card has one **Download** (the file as checked), **Send to…** and **Remove** (which removes the photo and its result and asks if it was not downloaded). **Download all (ZIP)** includes every result, also ones that failed QA.
- History keeps the settings and one QA line per photo. Photos and results are memory only.

**Limits and tips**
- The model must be an image-editing model that takes one reference image; otherwise the tool says so before sending.
- Free-only mode blocks this tool.

### Video studio

Generate, continue and extend video clips, arrange them on a timeline and join them into one MP4. Video studio needs a cross-origin isolated page; on your first visit it reloads once to get there ([Browser support](#browser-support)).

**Make: One clip**
- **Start from**: "Text only" (default), "First frame", "First and last frame", "Reference images", "Continue a clip (from its last frame)" or "Extend a clip (native, supported models)". Only the pickers for the chosen mode are shown.
- **Describe the video** (required for text and references). For Continue and Extend the box is "What happens next (optional)"; empty uses a built-in "continue the shot smoothly" prompt.
- Frames and references are PNG, JPEG or WebP (references up to 4). If both are set, the frames win and the references are dropped, with a note.
- **Upload a video to continue** (MP4, MOV or WebM) puts your own video on the timeline and selects Continue. The browser must be able to play it; convert other codecs to H.264 first.
- **Continue** takes the true last frame of the chosen clip in your browser and starts a new clip from it; the new clip lands right after its source. **Extend** sends the source video itself, and only works on models that take video input (such as Seedance) and with a public `https://` link in "Public link to the source video"; otherwise it falls back to Continue and says why.
- **Clip format** (from the chosen model's own options): **Length** (default 5 s), **Resolution**, **Shape** and **Sound** ("Model default (with sound)", "With sound" or "Silent").
- Settings drawer: **Exact size**, **Seed** (0 to 4,294,967,295; empty means a new one each time) and the switch **Notify me when videos are ready** (a browser notification when a clip or sequence finishes while the tab is in the background; the browser asks for permission when you turn it on).

**Generate**
- Press **Generate**. It sends the request, adds a job and frees the button at once, so you can start more clips or leave the page. A **Jobs** list shows each as Queued, Running, Done or Failed.
- A job is polled (about every 30 seconds after a quick start) only while a Video studio tab is open. Finished clips are downloaded then and placed on the timeline.
- The **x** on a job opens "Stop waiting for this clip?". OpenRouter cannot cancel a video job: it still finishes and may be billed, but this page will not download it.

**Make: Sequence**
- A list of 1 to 20 **Steps**, each with a prompt and optional images (reference images, or a last frame the step ends on).
- **How steps connect**: *Chained* (each step continues from the last frame of the one before; steps run one at a time, so the result plays as one shot; **First step continues** can start from a clip you already have) or *Independent* (each step is its own clip, up to three at once).
- **Style for every step** is appended to each prompt. **Run the list** N times (1 to 10). **Spend cap** stops before a step would pass it. **If a step fails**: "Stop" or "Skip it".
- The estimate line shows the total ("About $X for N clips"). **Start sequence** asks one budget question for the whole sequence (only when a limit would be broken), then runs. **Pause**, **Stop** and **Resume** work between steps; steps already sent still finish. **Re-run** on a step makes a new take; the old take stays on the timeline but is left out of the join, and the chained clip after it is marked so you can re-run it too.
- When a step cannot go on (a clip it continues from is gone, or its image was lost), the run pauses and offers choices: continue from another clip, send without a first frame, or re-run the previous step.
- While a sequence runs, step prompts, image roles and style are read-only; the cap and failure rule stay editable.

**Timeline and join**
- Each clip is a card with a player, **In the join**, **Leave out its first frame** (on for continuing clips, because that frame repeats the clip before), **Trim start** and **Trim end**, move up and down (Alt+Up/Down), **Continue**, **Extend**, **Frames**, **Download** (the untouched original MP4) and **Remove**.
- **Join into one MP4** combines the checked clips in order, in your browser. If nothing is trimmed and the clips match, they are copied losslessly and fast; otherwise every clip is re-encoded to H.264 and AAC and letterboxed to the first clip's size (about as slow as the footage is long on the single-threaded fallback). A join, and any single clip, is limited to 1.5 GB. The result is a card with **Download .mp4**, **Send to…** and **Remove**.
- **Frames** opens the frame grabber: a slider that steps by the clip's own frame rate, **Previous frame**, **Next frame** and **Save frame as PNG**. Saved frames can be used straight away as **first frame**, **last frame** or **reference**.

**After a reload**
- Saved in the browser: the timeline (order, names, prompts, trims), the sequence and the jobs. Generated clips are downloaded again from OpenRouter, which only keeps finished videos for a while (at least 18 minutes is confirmed). A clip it no longer has is marked expired: it was paid for, remove it or make it again.
- Not saved: uploaded videos and picked images. An uploaded clip says "Add the file again". A sequence step that lost its image pauses and asks you to add it again or send it without.

**Limits and tips**
- No video request is ever sent again automatically. If the answer to a request was lost, you get the "may have been billed" notice, not a Retry. "Stop waiting" and a job that gave up count against a spend cap as maybe billed.
- Leaving the page with jobs in flight opens the leave warning. Jobs only advance while a Video studio page is open, so a sequence waits for you to come back.
- The estimate is length times the model's per-second price, plus a per-image charge for models that bill input images.
- Free-only mode blocks this tool (no free video model).

### Decision

Ask yes/no, choice and score questions about a situation and get answers with probabilities.

**Input**
- **Situation**: a free "Text" box, or "Key-value fields" (name and value rows). Switching keeps both. You can drop text, JSON or XML files (up to 1,000,000 bytes) on the page; they are appended to the text.
- **Questions**: **Add question**, each with a name, a **Type** and instructions.
  - **Yes/No**: optional criteria for Yes and for No (fill in both or neither).
  - **Choice**: at least two options, each with a description.
  - **Score**: an ordered scale of at least two levels, lowest first (drag to reorder, or use Move up/down). The score is a position on the scale: 1.99 is almost level 2.
  - Every question has a **Threshold** (0 to 100 %, starting at 80) and an **Id** that names it in the request and the answers.
- Library bar: pick a **Starter template** (Ticket triage, Approve or escalate, Content review) or a **Saved decider**, then **Load**. **Save as…** keeps your questions (and, if you tick it, the situation) under a name; **Rename** and **Delete** manage saved ones. Saved deciders live in this browser.

**Settings drawer**
- **Starting threshold** for new questions (80). The model is chosen with the model chip. Jev (`typesafe/jev-1.13`, the default) and Mercury Decide (free) are the models verified to accept these questions; others may refuse them or answer in another shape.

**Run and read**
- Press **Decide**. One request answers all questions at once; there is no streaming.
- Each question becomes a card with a verdict, **Clear** or **Needs review**, shown against its threshold: a meter with Yes and No percentages, a bar per option with the chosen one marked, or a marker on the scale with a percentage per level. Changing a threshold relabels the cards without a new request.
- **Clear** means the model's confidence reached the threshold. No confidence is never Clear. Percentages are cut, not rounded, so 83.9 % stays below 84 %.
- **Download .json** and **Copy JSON** save the last run (model, state, questions, answers, usage).
- History keeps the situation, the questions with their thresholds and the answers as JSON; reopening a run restores the form.

**Limits and tips**
- The questions are answered independently and probabilities can drift a little between runs.
- The tool shows "Input: about N of M tokens" and refuses a run that does not fit the model's context.
- Cost is by input tokens only. It works in free-only mode with Mercury Decide.
- Decisions use OpenRouter's alpha endpoint, which may change.

### Bot-to-bot chat

Let two models talk to each other while you moderate, inside hard limits.

**Setup**
- For **Bot A** and **Bot B**: a **Name** (they must differ), a **Model** (empty means the default text model) and an optional **Persona**. The accordion "What each bot is told" shows the exact system message each bot gets.
- **Opening prompt**: what they should talk about. **Who speaks first** picks the starter.
- **Limits** (the first one reached ends the conversation; they count across pauses): **Turns** (default 20, counting both bots, so 10 each), **Minutes** (5), **Cost cap** ($0.25) and **Stop phrase** (`[END]`; empty means none). A bot ends a conversation by saying the stop phrase at the end of a message.
- The Settings drawer has **Max tokens per turn** (default 1000).
- This tool has no model chip in its header, because each bot has its own model.

**Run and moderate**
- **Start** begins (it becomes **Resume** once a conversation exists). **Step** runs exactly one turn and holds. While running, **Pause** takes effect after the current turn and **Stop** ends it. Ctrl/Cmd+Enter starts or resumes; Esc stops when you are not typing in a field.
- The **Moderator message** box (with **Send**) steers the conversation; both bots see it from their next turn.
- You can edit any turn, including the opening prompt, while paused. Editing removes everything after it (with Undo), and **Resume** carries on from there. Change names, personas and models while paused and press Resume; limits are read live.
- Three tiles show turns, time and cost against their limits and turn warning at 80 percent. Each turn shows the bot, its model, a usage line and badges (Cut, Stopped, Edited).

**Output**
- A badge shows "Not started", "Running", "Paused" or "Ended · Turn limit / Time limit / Cost cap / Stop phrase / Stopped". **Copy** puts the Markdown transcript on the clipboard, **Export** downloads **Markdown** or **JSON**, and **New conversation** clears it (with Undo).
- The conversation is saved in this browser as text. History gets one entry per Start, Resume or Step, with the transcript so far.

**Limits and tips**
- "Ended · Stopped" is not final: Resume continues it. After a turn, limits are checked in this order: time, stop phrase, cost, turns. Before a turn, the cost check assumes the turn uses all of Max tokens, so a paid bot whose estimate alone exceeds the cap cannot start; raise the cap or lower Max tokens.
- With a paid model and the default cap, Start asks for confirmation in Warn mode (the booking is above $0.10).
- A reply with no text is a failed turn ("It may have spent its token limit on reasoning"); raise Max tokens per turn or change the model.
- Only one tab can run a conversation at a time.
- Free-only mode refuses a bot whose model is not free.

### Model arena

Send one input to two to four models, vote blind, and compare answers, cost and speed.

**Input**
- **Prompt**, and files with **Attach files** (same types and limits as [Chat](#chat)). Every contender gets the same prompt and files.
- **Contenders**: 2 to 4 rows, each with **Change** and a remove button; **Add a contender** adds up to four. The first time, two free text models are picked. A row warns if its model is not free in free-only mode, cannot read your files, or the prompt is too long for it.

**Settings drawer**
- **Blind voting** (on): answers are shuffled and shown as Model A to D; names and costs appear after you vote.
- **System prompt** (sent to every contender), **Temperature** and **Max tokens** (clamped per model).
- Section **PDFs**: the **PDF reader**, as in Chat. A paid reader is charged for every contender.
- Your contenders and these settings are remembered; the prompt and files are not.

**Run**
- Press **Compare**. All contenders start together; the budget question is asked once for the whole round ("Model arena round: N models"). A round is all or none: if one contender is refused, none is sent.
- Each panel shows its status, the streaming answer and metrics: first token, total time, tokens, tokens per second and cost (cost shows "Hidden" while blind).
- A failed contender has **Retry** for just that one.

**Vote and compare**
- When every answer is in, "Which answer is best?" offers **Model A** to **D**, **Tie** and **All bad**, plus **Reveal without voting**. After voting, names, prices and the "Side by side" table appear, with badges for the fastest and the cheapest.
- "Your votes" keeps a tally per model (Wins, Ties, Rounds) in this browser, with **Reset** (and Undo).
- **Export** (Markdown or JSON) is available once names are shown and every answer is in. There is no Copy button.

**Limits and tips**
- History gets one entry per contender, with the model's answer text. The round on screen (panels, answers, vote) is memory only; a reload loses it.
- Free-only mode refuses the whole round if any contender or the PDF reader is paid.
- Errors read the same for every model while names are hidden, so a failure does not give away which models are free.
- Four free contenders send four requests at once, which counts toward the 20 per minute limit.

## The platform pages

The navbar on every page has the **Tools** menu (grouped as Documents, Audio, Images, Video and Reasoning), **Models**, **History**, **Stats** and **Settings**, a key menu (the default key, its masked id and balance, and **Manage keys**; an **Add key** button until you have one), a lock button (**Lock keys now** / **Unlock keys**) when the passphrase lock is on, the theme toggle (Light, Dark, System) and a search button for the command palette (Ctrl/Cmd+K). The footer links to [Privacy](#privacy), [Diagnostics](#diagnostics) and the GitHub repository.

### Home

Search first: type in the box (press `/` to jump to it) and Enter opens the best match. Below it:

- **Favorites**: tools you starred, with their star on the card. Star or unstar any tool anywhere.
- **Recent runs**: your five latest runs with their cost ("Free" for free models), each opening the run in its tool, and a link to all of History.
- **Every tool by category**. A tool card shows a "Free" badge when its main model is currently free.

New visitors see the setup wizard here (connect, pick favorites, try a sample).

### Models

The OpenRouter catalog, about 650 models, with your own numbers next to it.

- **Search** and filter by **Capability**, **Input**, **Output**, **Provider**, **Min context** and **Max price** (dollars per 1M tokens, input plus output), or tick **Free only** (ids ending in `:free`) or **Favorites only**. **Sort by** Best match, Name (A to Z), Newest first, Price (low to high) or Context (high to low). **Reset filters** clears them.
- Prices are shown in the model's real unit: per 1M tokens, per image, per 1M characters, per hour of audio, per clip, per request, or "varies" for video and routers. Price sorting puts free first and never compares different units. The max-price filter only covers token-priced models, and the page says how many other models it hides.
- Switch between **Cards** and **Table**. **Refresh** reloads the list from OpenRouter (it is cached and refreshed in the background).
- The star marks a favorite; favorites and a "Recently used" strip feed every model picker. Each card shows **Your use**: runs, average latency and spend with that model, from History. A badge warns about models that expire.
- Tick **Compare** on two to four models for a side-by-side table. The clipboard button copies a model id.

### History

Every run of every tool, newest first, grouped by day. Text only: images, audio and video are never stored.

- **Search** prompts, outputs and titles; filter by **Tool**, **Status** (Done, Failed, Stopped, Running), **Model**, **Key**, **From** and **To** dates, and **Starred only**. The list loads a page at a time ("Show more").
- A row opens a drawer with the prompt, settings, output, usage by model, errors and ids. From there: **Reopen in <tool>** (puts the prompt and settings back in the tool), **Re-run with another model**, **Star**, **Copy output**, **Export JSON** and **Delete** (with Undo). Runs in progress cannot be deleted.
- The **Export and delete** menu has **Export all as JSON**, **Export filtered as JSON** and **Delete filtered runs…** (you type `delete` to confirm; Undo is offered for a few seconds).
- History is deleted after the retention period (**Settings → Data**, 90 days by default). Starred runs are kept.

### Stats

A dashboard computed from this browser's daily spend ledger. Days are UTC, and the figures survive deleting History.

- Pick a range: **7 days**, **30 days**, **90 days**, **This month** or **Custom**.
- Tiles: **Spend**, **Requests**, **Runs**, **Error rate**, **Average latency** and **Free vs paid**. A figure marked `≈` includes estimates (a cost worked out from catalog prices, or the amount reserved for a run whose cost was unknown).
- Charts **Spend per day** and **Requests per day** (stacked by **Tool** or **Model**; beyond seven series the rest is "Other") and **Tokens per model**. Each has a legend that toggles series and a **Table view** with the same numbers.
- **By tool**, **By model** and **By key** tables, and **Budget and balances**: this month's budget use, free requests left today and each key's balance at OpenRouter. These always show the current month and day, whatever range you picked.

Stats only count what you ran in this browser. They will not match OpenRouter's activity page if you use the same key elsewhere.

### Settings

Eight sections, reachable from the side list or by link (`settings/#budgets`):

- **Keys**: add, rename, recolor, set default, remove; balance per key; the data-retention preference. See [First steps](#first-steps).
- **Default models**: the **Free-only mode** switch and one default model per capability (Text, Vision, Image generation, Text-to-speech, Speech-to-text, Video, Music, Decisions) with **Change** and **Reset**. ORtoolbox ships cheap, fast defaults and the best free model where one exists. Choosing the shipped model again means "follow the shipped default". The page also lists which capabilities have no free model, and how many free requests you used today.
- **Tool bindings**: pin a key or a model to one tool. The tool's own model chip and key chip set the same thing. Bot-to-bot chat and Model arena choose their models inside the tool, so there is nothing to pin.
- **Budgets**: mode, per-run threshold, monthly limits, with this month's spend. See [First steps](#4-budgets-and-cost-estimates).
- **Appearance**: **Theme** (Light, Dark, System), **Accent color** (picker, eight presets, Reset; text on buttons and links switches between light and dark to stay readable), **Density** (Comfortable or Compact) and **Reduce motion**. Changes apply at once on every open page.
- **Passphrase lock**: see [First steps](#2-optional-lock-your-keys-with-a-passphrase).
- **Data**: storage used; **Keep history and recent prompts for** N days (default 90; saved prompts and starred runs are always kept); **Record recent prompts**; a table of recent prompts, saved prompts and runs per tool with a delete button per row; **Delete all prompts and history** (type `delete all`; keys, settings and spending stats stay) and **Reset everything** (type `reset everything`; removes keys, settings, stats and the lock, as if ORtoolbox had never been opened here).

### Backup and restore

Settings → **Backup and restore** moves ORtoolbox between browsers or keeps a copy.

**Download a backup**
- Choose **Everything** (settings, saved and recent prompts, history, video jobs, tool state and spending stats) or **Settings only** (settings and saved prompts).
- Keys are left out. Switch on **Include keys (encrypted with a passphrase)** to add them; they are encrypted with the passphrase you choose here (it can differ from your lock passphrase, and you need it to restore).
- **Download backup** saves `ortoolbox-YYYY-MM-DD.ortoolbox.json`.

**Restore from a backup**
- Drop the file. Choose **Merge** (add what is new, update what is newer, keep the rest) or **Replace** (make this browser match the backup; what the backup lacks is deleted within what it contains). If the file has keys, enter its passphrase, or leave it empty to restore everything else.
- **Preview** lists exactly what would change, with deletions set apart; invalid records are skipped and counted. Nothing is written until you press **Merge into this browser** or **Replace with this backup** (Replace asks again). A wrong passphrase imports nothing.
- Imported runs that were still running arrive as stopped. Settings pointing at keys this browser does not have are dropped.

### Privacy

The Privacy page says in plain words what is stored where and what leaves the browser. In short: there is no ORtoolbox server, no analytics and no cookies; a run sends its prompt and files to OpenRouter and the model provider; settings, favorites and keys are in local storage, history and prompts in IndexedDB, and images, audio and video in memory only. See also the [README](../README.md#privacy-and-security).

### Diagnostics

The Diagnostics page shows what this browser provides on this site: **Cross-origin isolated**, **SharedArrayBuffer**, **Service worker** state, **Cross-Origin-Embedder-Policy**, storage used, logical CPU cores, the site's base path, the build and your browser. **Run ffmpeg test** downloads the ffmpeg core (about 32 MB, cached afterwards) and encodes a two-second test clip, with the multi-threaded core when the page is isolated; **Run with the single-threaded core** tries the fallback. If it passes, Video studio joins, Text-to-speech MP3 and the other ffmpeg features will work. On a first visit this page may reload once to become isolated.

## Troubleshooting

**A tool says it needs a key, or "Add an OpenRouter key".**
Add one in Settings → Keys (Connect with OpenRouter, or paste). If you already did and the keys are locked, the dialog asks for your passphrase instead.

**"Your keys are locked."**
You turned on the passphrase lock and this tab has not been unlocked. Press **Unlock keys** in the navbar, or enter the passphrase in the dialog. If you forgot it, there is no recovery: use Settings → Data → Reset everything, or remove the keys, then add them again (restore a backup made without keys if you have one).

**"Blocked by your budget" or a "Confirm this run" dialog.**
Budgets compare the estimate with the per-run threshold and your monthly limits. In Warn mode the dialog lets you run anyway. A Hard stop block names the limit; raise it, switch the mode, or wait for the new UTC month. Budgets count only what you ran in this browser. If the dialog appears more often than you like, raise the per-run threshold.

**"Free-only mode is on".**
The model you chose is not free, or the tool uses a paid add-on (Mistral OCR, for example). Pick a free model, change the add-on, or turn the mode off in Settings → Default models. A tool with no free model at all ("This tool cannot run in free-only mode") needs the mode off.

**"Rate limited" on a free model.**
Free models allow 20 requests a minute and a daily quota (50 a day, or 1,000 once your OpenRouter account has bought $10 of credits). ORtoolbox waits before sending more than 20 a minute, so the 429 you may see is usually the daily quota or the provider's own limit. Wait, switch to another model, or use a paid one. Four free contenders in Model arena use four of the 20 at once.

**Out of credit, or the key's limit is reached.**
OpenRouter rejects requests when the account or the key has no credit left. Settings → Keys shows the balance. Add credit or raise the key's limit on OpenRouter.

**"This may have gone through".**
A paid request lost its connection after it was sent, or got a server error. The provider may still have done the work and billed it, so ORtoolbox does not offer a plain Retry. Open the **OpenRouter activity** link and look for the request. If it is not there, run it again by hand. Tools that handle this differently (Text-to-speech parts, Speech-to-text parts, Video studio) never retry on their own and give you a Retry for just the missing pieces.

**My images, audio or video are gone after a reload.**
They are never stored (only text goes to History). Download results before leaving; the leave warning lists what is not downloaded yet.

**Video jobs after a reload.**
See [Video studio](#video-studio). Jobs and the sequence state are saved; clips are downloaded again from OpenRouter while it still has them; uploaded videos and images must be added again.

**The model list cannot be loaded.**
Open Models and press **Refresh**. A failed load is remembered for five minutes. Tools keep working with cached models and the shipped defaults.

**"Browser storage is full".**
Delete history in Settings → Data (per tool or all), or lower the retention days.

**Ctrl+V or a drop does nothing.**
Tools take only the file types they support and show a toast with what they skipped. Pasting does not work while a text field also carries text.

**A first visit reloads once.**
Video studio and Diagnostics reload once on your first visit to become cross-origin isolated. No other page does.

## Browser support

ORtoolbox targets current versions of Chrome and Edge (Chromium), Firefox and Safari. The automated tests run in Chromium, Firefox and WebKit.

- **Cross-origin isolation.** Multi-threaded ffmpeg (video joining and trimming, audio joins, WAV and MP3 conversion, cutting long recordings) needs the page to be cross-origin isolated. GitHub Pages cannot send the headers, so the site's service worker adds them; the first visit registers it and the next page load is isolated. If your browser blocks service workers (some private windows), ffmpeg falls back to a single thread: slower, same result. Diagnostics shows the state.
- **Offline.** The service worker also keeps the app shell, so the pages open without a network and History and settings stay readable. Tools need the network to run.
- **Install.** The site can be installed as an app from your browser's menu.
- **Microphone.** Recording needs a secure page (https), a browser with MediaRecorder and your permission.
- **Safari** cannot write WebP from the canvas, so image cards drop that format from their download menu after one failed attempt.
- **Reduced motion and themes** follow your system settings; Settings → Appearance can override.
