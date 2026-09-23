# MultichannelLive

An Ableton Live extension for working with interleaved multichannel audio.
It splits a multichannel file into clips across tracks, and bounces selected
tracks back out into a single multichannel file.

Built with `@ableton-extensions/sdk` (1.0.0-beta).

## What it does

1. You pick a multichannel file (or right-click one that is already in the Set).
2. A dialog shows the file's format and one row per output clip, with a target
   track for each. Defaults follow the arrangement selection.
3. The file is de-interleaved into `<Project>/multichannel_clips/`, or into a
   folder of your choosing.
4. Clips are created on the target tracks at the selected arrangement position.

## Entry points

| Right-click on | Action | Behaviour |
| --- | --- | --- |
| An arrangement time selection on an audio track | **Load Multichannel File…** | Opens the routing dialog. The time selection sets the position; the selected tracks become the default targets |
| An arrangement time selection on an audio track | **Multichannel Bounce…** | Renders the selected tracks over the selected range into one multichannel file — see below |
| An audio track header | **Load Multichannel File…** | Opens the routing dialog, with that track as the first target and the position defaulting to beat 0 |
| An audio clip | **Split to Mono** | No dialog. Splits in place — see below |
| A sample | **Load Multichannel File…** | Opens the routing dialog at beat 0 |

**There is no main-menu or toolbar entry, because API 1.0.0 has no way to add
one.** `UiModule_1_0_0` exposes exactly three calls — `registerContextMenuAction`,
`showModalDialog` and `showProgressDialog` — so a right-click menu is the only
surface an extension can attach itself to. The available scopes are `AudioClip`,
`AudioTrack`, `ClipSlot`, `DrumRack`, `MidiClip`, `MidiTrack`, `Sample`, `Scene`,
`Simpler`, `ClipSlotSelection` and the two `*.ArrangementSelection` scopes; the
four most useful ones are registered above. If a later API version adds a menu
or shortcut surface, that is where it would go.

## Multichannel Bounce

Select some audio tracks and a time range in the arrangement, right-click, and
**Multichannel Bounce…** renders each track and interleaves them into a single
multichannel WAV.

> [!IMPORTANT]
> **The bounce is pre-effects, and automation is ignored.**
> `resources.renderPreFxAudio()` is the only render call in API 1.0.0 and
> renders a track *before* its device chain and mixer, so **effects and sends
> are not included** and cannot be — there is no post-FX render API.
>
> Volume and pan *are* applied, by reading the mixer and folding the gain in
> afterwards. That uses each parameter's **current value only**. The SDK has no
> automation or envelope API at all, so a fader move written into the
> arrangement is not read — the whole bounce gets the level the fader happens
> to sit at. The dialog says all of this on its face.

Tracks are rendered *before* the routing dialog opens. That is deliberate: a
stereo track renders two channels and a mono one renders one, so routing per
*track* would quietly drop a stereo track's right side. Rendering first lets the
dialog offer exactly the channels that exist, and label them (`Gtr (L)`,
`Gtr (R)`).

In the dialog:

- **Apply track volume and pan** — on by default. Each row shows the level it
  will get (`-6.0 dB · pan 25R`) so you can check it against Live's mixer
  before committing. Turn it off for raw pre-fader stems.
- **File name** and **Save to** — the same destination as the splitter.
- **Channels** — the output channel count, defaulting to the number of source
  channels. Raise it to leave gaps; unassigned channels are written as silence.
- One row per source channel, each with an output channel or *Do not bounce*.
  Two sources on one channel is refused, in the dialog and again when the reply
  is parsed.

Output is `WAVE_FORMAT_EXTENSIBLE` above two channels, with `channelMask` left
at 0 — the channels are discrete, not a named speaker layout, which is the
honest description of a routing you chose yourself. Files over 4 GB are written
as RF64, so long bounces are not capped.

Inputs of different lengths are padded with silence to the longest. Only
**audio tracks** can be rendered; the SDK's render call takes an `AudioTrack`,
so MIDI tracks (even with instruments) cannot be bounced.

### How volume and pan are applied

Pan is a left/right **balance**, matching Live: panning right attenuates the
left channel and leaves the right alone, and centre is unity on both sides. It
is only applied to a **stereo** render, where channel 1 is left and channel 2 is
right; a mono render gets the volume and nothing else, because a balance has no
meaning for a single channel.

Volume needs a linear multiplier, and getting there depends on a unit the SDK
does not state — the calls are named `deviceParameterGetInternal{Value,Min,Max}`
and nothing says what "internal" means. So the unit is **inferred from the
range**:

- A range reaching below -1 (e.g. -70…+6) is taken to already be dB and is used
  directly. This is exact.
- Anything else is treated as Live's 0…1 fader position and converted through
  `FADER_CURVE` in `src/live/mixer.ts`. Only two points there are certain —
  `0.85` is unity and `1.0` is +6 dB — and the rest approximate the curve
  between. **This path is an approximation**, the dialog says so, and the
  printed dB is there to be compared against Live's own readout.

If a bounce comes out at the wrong level, `FADER_CURVE` is the single thing to
correct; nothing else depends on those numbers.

Channels at unity gain keep the plain byte-copy path, so an unmodified channel
stays bit-for-bit identical to its render. Where gain is applied, integer
formats are rounded and **clamped**, so a boost clips rather than wrapping into
noise; float formats are left unclamped, since values above 0 dBFS are legal
there and clamping would throw away headroom.

## Split to Mono

Right-clicking a multichannel clip splits it in place, with no dialog:

- The source track is duplicated once per channel, so every mono clip keeps the
  original's devices, mixer settings and routing.
- Each duplicate arrives carrying a copy of the multichannel clip; that copy is
  cleared from the source clip's range before the mono clip is placed. Any
  *other* clips on the track are duplicated along with it — that is what
  duplicating a track means, and they are left alone.
- The mono clips mirror the source clip's trim, loop and warp settings, so a
  trimmed clip stays trimmed.
- The source clip is **muted** afterwards, so it does not double what you just
  split out. It is muted last, so a failure anywhere above leaves the Set
  untouched.
- Clips are coloured with the default clip colour (no dialog to pick one).

## Dialog options

- **Split as** — *Mono files* (one clip per channel) or *Stereo pairs*
  (channels 1+2, 3+4, …; a trailing odd channel becomes a mono clip).
- **Start at** — arrangement position in beats, seeded from the selection.
- **Warp clips** — off by default, which is usually what you want for stems and
  field recordings.
- **Rename existing target tracks** — off by default, so your track names are
  not clobbered. Newly created tracks are always named after their channel.
- **Save to** — where the de-interleaved files are written. Defaults to
  `<Project>/multichannel_clips`; *Change…* opens a folder chooser and *Reset*
  goes back to the default. The choice is remembered across Live sessions in
  the extension's storage directory.
- **Clip color** — every clip from one import gets the same colour, so an import
  reads as a group. Live keeps a fixed 60-entry clip palette and snaps an
  assigned colour to its nearest entry, so the swatches are approximations of
  palette hues rather than exact values. *Default* leaves Live's own colouring
  alone.
- **Target tracks** — a dropdown per clip listing every audio track in the Set,
  plus *＋ New audio track*. *Fill down* assigns consecutive tracks from the
  first target; *All to new tracks* routes everything to fresh tracks.

## Audio handling

WAV, RF64 and AIFF/AIFC are read directly. De-interleaving is a frame-aligned
**byte copy** — sample rate, bit depth and encoding are preserved exactly, with
no decode or resample step. AIFF's big-endian words are byte-swapped so the
output is a valid WAV. Files are streamed in 4 MB chunks, so a multi-gigabyte
recording does not have to fit in memory, and the progress dialog can be
cancelled mid-split.

`WAVE_FORMAT_EXTENSIBLE` channel masks are used to label channels (`L`, `R`,
`C`, `LFE`, `Ls`, `Rs`, …). Failing that, channel counts of 4, 9 or 16 are
labelled as ambisonic components in ACN order, and anything else is numbered.

Other containers (FLAC, CAF, W64, MP4, …) are decoded to an intermediate
32-bit float WAV via `ffmpeg` if one is on the system; without ffmpeg those
formats are rejected with a message rather than failing silently.

## Implementation notes

Two things the Extensions SDK does not offer, and how they are worked around:

- **No file picker.** A WebView dialog cannot see real filesystem paths, so
  `src/util/filePicker.ts` shells out to the native chooser (`osascript` on
  macOS, `OpenFileDialog` on Windows).
- **No project path.** `resources.importIntoProject()` is the only API that
  touches the Project folder, so `src/live/project.ts` imports a one-frame
  throwaway WAV, reads the Project root off the path Live returns, deletes the
  copy, and walks up to the `Ableton Project Info` marker.

### Output folder

The default is `<Project>/multichannel_clips`, created on demand. Choosing your
own folder in the dialog overrides that for every Set, and is stored in
`settings.json` in the extension's storage directory.

Picking a custom folder also takes the Set's save state out of the picture —
there is no Project folder to find, so the unsaved-Set warning does not apply.

A WebView dialog cannot open a native folder chooser or call back into the
host; `close_and_send` is its only channel. So *Change…* closes the dialog,
runs the chooser and reopens it. Everything already set — mode, routing for
*both* modes, start position, colour and the checkboxes — travels out and back
in, so nothing is lost.

If the chosen folder later becomes unwritable (an unplugged drive, say), the
extension offers the Project folder for that run and leaves the preference
alone, so it starts working again when the drive comes back.

### Unsaved Live Sets

Live only creates a Project folder when a Set is saved, so until then there is
no `<Project>/multichannel_clips` to write to. The `Ableton Project Info` marker
is the reliable signal: if walking up from the imported probe never finds it,
the Set has not been saved and whatever Live handed back is a temporary
location that Live is free to clear — and that *Collect All and Save* will not
have gathered from.

Rather than guessing, the extension **warns before doing any work**, shows the
exact path it would write to, and offers *Cancel* (save the Set first) or
*Continue anyway*. Escape always cancels, so dismissing the dialog never counts
as consent. Setting a custom output folder sidesteps the problem entirely.

Note that Max for Live's usual trick — read `live_set.file_path` and treat an
empty string as "never saved" — is not available here. The Extensions SDK is a
different API surface from the LOM, and its whole `Song` model is tracks,
scenes, cue points, tempo, grid and scale, with no file path and no save state.

Tracks are created one at a time so they land in channel order — Live inserts
each new track after the current selection. The clips themselves are created
inside a single transaction, so placing them is one undo step.

## Layout

```
src/
  extension.ts        activation, context-menu commands, orchestration
  audio/
    probe.ts          format detection and the ffmpeg fallback
    wav.ts            WAV/RF64 reader, WAV header writer, channel masks
    aiff.ts           AIFF/AIFC reader
    split.ts          streaming de-interleaver
    interleave.ts     streaming interleaver (the bounce)
    grouping.ts       mono/stereo grouping and output file naming
  live/
    project.ts        Project folder discovery, output folder validation
    settings.ts       persisted preferences (output folder)
    mixer.ts          reading volume/pan and resolving them to gains
    placement.ts      track resolution, track creation, clip placement,
                      in-place split onto track duplicates
  ui/
    dialog.ts         split dialog state injection and result parsing
    bounceDialog.ts   bounce dialog state injection and result parsing
  util/filePicker.ts  native file and folder choosers
ui/
  interface.html      the split routing dialog
  bounce.html         the bounce routing dialog
  message.html        the notice / confirmation dialog
```

## Known gaps

- Session view is not a destination; clips are only placed in the arrangement.
  `ClipSlot.createAudioClip` exists, so a `ClipSlot` / `ClipSlotSelection` scope
  could be added.
- The bounce is pre-effects only and cannot render MIDI tracks (see above).
- Volume and pan automation is not read — there is no automation API in the SDK.
  Only the parameters' current values are used.
- Sends and return tracks are not part of a pre-FX bounce.
- **Split to Mono** always splits the whole file. The clip's trim is reproduced
  with markers rather than by trimming the audio, so the split files on disk are
  full length.

## Setup

The path to Ableton Live's Extension Host module is stored in `.env` as
`EXTENSION_HOST_PATH`. The generator filled this in; edit it if your install
moves.

## Scripts

```sh
npm start                  # build + run in Live's Extension Host
npm run build              # production bundle of src/extension.ts
npm run build:dev          # dev bundle (sourcemaps, not minified)
npm run package            # build for production + create a .ablx archive
```
