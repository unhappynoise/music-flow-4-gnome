# Music Flow for GNOME

An MPRIS media widget for the GNOME Shell top bar — see what's playing and control it (play, pause, skip) without switching apps.

## Why this exists

I first heard about [Music Flow](https://github.com/Clifford-Baidoo/Omarchy-music-flow) from a senior who'd built it — a slick MPRIS media widget for the bar. I installed it without checking closely, and only after running into `command not found` did I realize it was built specifically for Omarchy (Arch + Hyprland), not for the Ubuntu/GNOME setup I actually run.

But the itch was real: I wanted to skip a song without alt-tabbing to Spotify every time a track I didn't like came on. If I had that problem, I figured other GNOME users on Ubuntu probably did too — so instead of giving up on the idea, I decided to build a GNOME-native version myself.

This is step one. There may already be extensions that do parts of this — but building my own, however small, is worth it both as a contribution and as a way to actually learn GNOME Shell extension development (with an AI assistant alongside me for the ride). Long term, I'd like to expand this beyond GNOME — ideally something closer to distro-agnostic on Linux, and maybe eventually macOS and Windows too.

## What it does

- Shows the currently playing track's title and artist right in your GNOME top bar
- Works with **any** MPRIS-compatible player at once — Spotify, VLC, Firefox/Chrome media (YouTube, etc.) — not locked to one app
- Automatically follows whichever player is actually playing, even if you switch between apps without pausing the other first
- Play / pause / next / previous controls in the dropdown menu, wired to whichever player is currently active
- Play/pause button icon reflects real playback state live

## Requirements

- GNOME Shell **45 or newer** (built and tested on GNOME 46.0, Wayland)
- Ubuntu or any GNOME-based distro

## Installation

Clone this repo into your GNOME Shell extensions directory:

```bash
git clone https://github.com/unhappynoise/music-flow-4-gnome.git ~/.local/share/gnome-shell/extensions/musicflow@unhappynoise
```

Enable it:

```bash
gnome-extensions enable musicflow@unhappynoise
```

**Log out and log back in** (GNOME Shell on Wayland doesn't hot-reload extensions — this is required after installing or updating).

You should see the widget appear in your top bar showing the current track, or "No music playing" if nothing's active.

## Usage

- The bar shows `Title — Artist` for whatever's currently playing
- Click the widget to open the dropdown, which shows previous / play-pause / next buttons
- The widget automatically switches to whichever player most recently started playing

## Roadmap

- [x] Animated soundwave visualizer (stylized, non-audio-reactive)
- [ ] Floating player panel with album art
- [ ] Volume/seek controls
- [ ] Real audio-reactive visualizer using PipeWire (v2)
- [ ] Wider distro support beyond GNOME

## Credits

Inspired by [Omarchy Music Flow](https://github.com/Clifford-Baidoo/Omarchy-music-flow) by Clifford Baidoo — built from scratch for GNOME Shell since the original targets Omarchy/Quickshell specifically.

## License

MIT
