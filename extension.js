import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_OBJECT_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';

const BAR_COUNT = 4;
const WAVE_WIDTH = 24;
const WAVE_HEIGHT = 16;
const ART_SIZE = 96;

const WaveVisualizer = GObject.registerClass(
class WaveVisualizer extends St.DrawingArea {
    _init() {
        super._init({
            width: WAVE_WIDTH,
            height: WAVE_HEIGHT,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._phase = 0;
        this._playing = false;
        this._timeoutId = null;
    }

    setPlaying(isPlaying) {
        if (isPlaying === this._playing)
            return;

        this._playing = isPlaying;

        if (isPlaying && !this._timeoutId) {
            this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
                this._phase += 1;
                this.queue_repaint();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!isPlaying && this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
            this.queue_repaint();
        }
    }

    vfunc_repaint() {
        let cr = this.get_context();
        let [width, height] = this.get_surface_size();
        let barWidth = width / BAR_COUNT;

        cr.setSourceRGBA(1, 1, 1, 0.9);

        for (let i = 0; i < BAR_COUNT; i++) {
            let barHeight;
            if (this._playing) {
                let wave = Math.sin((this._phase + i * 2) * 0.6);
                barHeight = height * (0.35 + 0.3 * Math.abs(wave));
            } else {
                barHeight = height * 0.15;
            }

            let x = i * barWidth + barWidth * 0.2;
            let y = (height - barHeight) / 2;
            cr.rectangle(x, y, barWidth * 0.6, barHeight);
        }

        cr.fill();
        cr.$dispose();
    }

    destroy() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        super.destroy();
    }
});

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, _('Music Flow'));
        this.menu.box.style = 'min-width: 280px;';

        let box = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._wave = new WaveVisualizer();
        box.add_child(this._wave);

        this._label = new St.Label({
            text: _('No music playing'),
            y_align: Clutter.ActorAlign.CENTER,
            style: 'margin-left: 6px;',
        });
        box.add_child(this._label);

        this.add_child(box);

        this._proxies = new Map();
        this._lastChanged = new Map();
        this._signalHandlerIds = new Map();
        this._activeProxy = null;
        this._activeBusName = null;
        this._lastArtUrl = null;
        this._trackLength = 0;
        this._currentPosition = 0;
        this._userSeeking = false;
        this._positionTimeoutId = null;

        this._buildNowPlayingPanel();
        this._buildSeekBar();
        this._buildControls();

        this._nameOwnerId = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus',
            'org.freedesktop.DBus',
            'NameOwnerChanged',
            '/org/freedesktop/DBus',
            null,
            Gio.DBusSignalFlags.NONE,
            (conn, sender, path, iface, signal, params) => {
                let [name, oldOwner, newOwner] = params.deep_unpack();
                if (!name.startsWith(MPRIS_PREFIX))
                    return;

                if (newOwner === '') {
                    let proxy = this._proxies.get(name);
                    let handlerId = this._signalHandlerIds.get(name);
                    if (proxy && handlerId)
                        proxy.disconnect(handlerId);
                    this._proxies.delete(name);
                    this._lastChanged.delete(name);
                    this._signalHandlerIds.delete(name);
                    this._pickActivePlayer();
                } else if (oldOwner === '') {
                    this._connectToPlayer(name);
                }
            }
        );

        this._discoverExistingPlayers();
    }

    _buildNowPlayingPanel() {
        let panelItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });

        let row = new St.BoxLayout({
            x_expand: true,
            style: 'padding: 6px;',
        });

        this._artIcon = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            icon_size: ART_SIZE,
            style: 'margin-right: 10px;',
        });
        row.add_child(this._artIcon);

        let textBox = new St.BoxLayout({
            vertical: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._panelTitleLabel = new St.Label({
            text: _('No music playing'),
            style: 'font-weight: bold; font-size: 1.3em;',
        });
        this._panelArtistLabel = new St.Label({
            text: '',
            style: 'opacity: 0.7; font-size: 1.05em;',
        });

        textBox.add_child(this._panelTitleLabel);
        textBox.add_child(this._panelArtistLabel);
        row.add_child(textBox);

        panelItem.add_child(row);
        this.menu.addMenuItem(panelItem);
    }

    _buildSeekBar() {
        let seekItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });

        let container = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style: 'padding: 4px 6px;',
        });

        this._seekSlider = new Slider.Slider(0);
        this._seekSlider.x_expand = true;

        this._seekSlider.connect('drag-begin', () => {
            this._userSeeking = true;
        });
        this._seekSlider.connect('drag-end', () => {
            this._userSeeking = false;
            this._performSeek();
        });

        let timeRow = new St.BoxLayout({
            x_expand: true,
        });
        this._elapsedLabel = new St.Label({
            text: '0:00',
            style: 'font-size: 0.85em; opacity: 0.7;',
        });
        this._totalLabel = new St.Label({
            text: '0:00',
            style: 'font-size: 0.85em; opacity: 0.7;',
            x_align: Clutter.ActorAlign.END,
            x_expand: true,
        });
        timeRow.add_child(this._elapsedLabel);
        timeRow.add_child(this._totalLabel);

        container.add_child(this._seekSlider);
        container.add_child(timeRow);

        seekItem.add_child(container);
        this.menu.addMenuItem(seekItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    }

    _buildControls() {
        let controlItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });

        let box = new St.BoxLayout({
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._prevButton = this._makeButton('media-skip-backward-symbolic', () => {
            this._callPlayerMethod('Previous');
        });
        this._playPauseButton = this._makeButton('media-playback-start-symbolic', () => {
            this._callPlayerMethod('PlayPause');
        });
        this._nextButton = this._makeButton('media-skip-forward-symbolic', () => {
            this._callPlayerMethod('Next');
        });

        box.add_child(this._prevButton);
        box.add_child(this._playPauseButton);
        box.add_child(this._nextButton);

        controlItem.add_child(box);
        this.menu.addMenuItem(controlItem);
    }

    _makeButton(iconName, callback) {
        let button = new St.Button({
            style_class: 'button',
            can_focus: true,
            child: new St.Icon({
                icon_name: iconName,
                icon_size: 16,
            }),
        });
        button.connect('clicked', callback);
        return button;
    }

    _callPlayerMethod(method) {
        if (!this._activeProxy)
            return;

        this._activeProxy.call(
            method,
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (proxy, res) => {
                try {
                    this._activeProxy.call_finish(res);
                } catch (e) {
                    logError(e, `Music Flow: failed to call ${method}`);
                }
            }
        );
    }

    _discoverExistingPlayers() {
        Gio.DBus.session.call(
            'org.freedesktop.DBus',
            '/org/freedesktop/DBus',
            'org.freedesktop.DBus',
            'ListNames',
            null,
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (conn, res) => {
                let [names] = conn.call_finish(res).deep_unpack();
                names.filter(n => n.startsWith(MPRIS_PREFIX))
                    .forEach(name => this._connectToPlayer(name));
            }
        );
    }

    _connectToPlayer(busName) {
        if (this._proxies.has(busName))
            return;

        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SESSION,
            Gio.DBusProxyFlags.NONE,
            null,
            busName,
            MPRIS_OBJECT_PATH,
            MPRIS_PLAYER_IFACE,
            null,
            (source, res) => {
                let proxy;
                try {
                    proxy = Gio.DBusProxy.new_for_bus_finish(res);
                } catch (e) {
                    logError(e, `Music Flow: failed to connect to ${busName}`);
                    return;
                }

                this._proxies.set(busName, proxy);
                this._lastChanged.set(busName, Date.now());

                let handlerId = proxy.connect('g-properties-changed', () => {
                    this._lastChanged.set(busName, Date.now());
                    this._pickActivePlayer();
                });
                this._signalHandlerIds.set(busName, handlerId);

                this._pickActivePlayer();
            }
        );
    }

    _pickActivePlayer() {
        let bestBusName = null;
        let bestTime = -1;

        for (let [busName, proxy] of this._proxies.entries()) {
            let status = proxy.get_cached_property('PlaybackStatus');
            let statusStr = status ? status.deep_unpack() : null;

            if (statusStr === 'Playing') {
                let t = this._lastChanged.get(busName) || 0;
                if (t > bestTime) {
                    bestTime = t;
                    bestBusName = busName;
                }
            }
        }

        if (bestBusName) {
            this._activeProxy = this._proxies.get(bestBusName);
            this._activeBusName = bestBusName;
            this._updateNowPlaying(this._activeProxy);
            this._updatePlayPauseIcon(true);
            this._wave.setPlaying(true);
            this._startPositionPolling();
            return;
        }

        for (let [busName, proxy] of this._proxies.entries()) {
            let status = proxy.get_cached_property('PlaybackStatus');
            if (status && status.deep_unpack() === 'Paused') {
                this._activeProxy = proxy;
                this._activeBusName = busName;
                this._updateNowPlaying(proxy);
                this._updatePlayPauseIcon(false);
                this._wave.setPlaying(false);
                this._stopPositionPolling();
                return;
            }
        }

        this._activeProxy = null;
        this._activeBusName = null;
        this._updateNowPlaying(null);
        this._updatePlayPauseIcon(false);
        this._wave.setPlaying(false);
        this._stopPositionPolling();
        this._resetSeekUI();
    }

    _updatePlayPauseIcon(isPlaying) {
        let icon = this._playPauseButton.get_child();
        icon.icon_name = isPlaying
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';
    }

    _updateNowPlaying(proxy) {
        if (!proxy) {
            this._label.set_text(_('No music playing'));
            this._panelTitleLabel.set_text(_('No music playing'));
            this._panelArtistLabel.set_text('');
            this._setArtwork(null);
            this._trackLength = 0;
            return;
        }

        let metadata = proxy.get_cached_property('Metadata');
        if (!metadata) {
            this._label.set_text(_('No music playing'));
            this._panelTitleLabel.set_text(_('No music playing'));
            this._panelArtistLabel.set_text('');
            this._setArtwork(null);
            this._trackLength = 0;
            return;
        }

        let dict = metadata.deep_unpack();
        let title = dict['xesam:title'] ? dict['xesam:title'].deep_unpack() : 'Unknown title';
        let artistArr = dict['xesam:artist'] ? dict['xesam:artist'].deep_unpack() : ['Unknown artist'];
        let artist = artistArr[0] || 'Unknown artist';
        let artUrl = dict['mpris:artUrl'] ? dict['mpris:artUrl'].deep_unpack() : null;
        let length = dict['mpris:length'] ? dict['mpris:length'].deep_unpack() : 0;

        this._label.set_text(`${title} — ${artist}`);
        this._panelTitleLabel.set_text(title);
        this._panelArtistLabel.set_text(artist);
        this._setArtwork(artUrl);
        this._trackLength = length;
        this._totalLabel.set_text(this._formatTime(length));
    }

    _setArtwork(url) {
        if (url === this._lastArtUrl)
            return;

        this._lastArtUrl = url;

        if (!url) {
            this._artIcon.gicon = null;
            this._artIcon.icon_name = 'audio-x-generic-symbolic';
            return;
        }

        try {
            let file = Gio.File.new_for_uri(url);
            this._artIcon.gicon = new Gio.FileIcon({file});
        } catch (e) {
            logError(e, 'Music Flow: failed to load album art');
            this._artIcon.gicon = null;
            this._artIcon.icon_name = 'audio-x-generic-symbolic';
        }
    }

    _startPositionPolling() {
        if (this._positionTimeoutId)
            return;

        this._fetchPosition();
        this._positionTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this._fetchPosition();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPositionPolling() {
        if (this._positionTimeoutId) {
            GLib.source_remove(this._positionTimeoutId);
            this._positionTimeoutId = null;
        }
    }

    _fetchPosition() {
        if (!this._activeProxy || !this._activeBusName || this._userSeeking)
            return;

        this._activeProxy.get_connection().call(
            this._activeBusName,
            MPRIS_OBJECT_PATH,
            'org.freedesktop.DBus.Properties',
            'Get',
            new GLib.Variant('(ss)', [MPRIS_PLAYER_IFACE, 'Position']),
            new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (conn, res) => {
                try {
                    let reply = conn.call_finish(res);
                    let [variant] = reply.deep_unpack();
                    let position = variant.deep_unpack();
                    this._updateSeekUI(position);
                } catch (e) {
                    // Some players don't support Position reads — ignore quietly
                }
            }
        );
    }

    _updateSeekUI(positionMicro) {
        this._currentPosition = positionMicro;

        if (this._trackLength > 0)
            this._seekSlider.value = Math.min(1, positionMicro / this._trackLength);

        this._elapsedLabel.set_text(this._formatTime(positionMicro));
    }

    _resetSeekUI() {
        this._seekSlider.value = 0;
        this._elapsedLabel.set_text('0:00');
        this._totalLabel.set_text('0:00');
        this._currentPosition = 0;
    }

    _performSeek() {
        if (!this._activeProxy || this._trackLength <= 0)
            return;

        let metadata = this._activeProxy.get_cached_property('Metadata');
        if (!metadata)
            return;

        let dict = metadata.deep_unpack();
        let trackId = dict['mpris:trackid'] ? dict['mpris:trackid'].deep_unpack() : null;
        if (!trackId)
            return;

        let targetPosition = Math.floor(this._seekSlider.value * this._trackLength);

        this._activeProxy.call(
            'SetPosition',
            new GLib.Variant('(ox)', [trackId, targetPosition]),
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (proxy, res) => {
                try {
                    this._activeProxy.call_finish(res);
                } catch (e) {
                    logError(e, 'Music Flow: SetPosition failed');
                }
            }
        );

        this._currentPosition = targetPosition;
        this._elapsedLabel.set_text(this._formatTime(targetPosition));
    }

    _formatTime(micro) {
        let totalSeconds = Math.floor(micro / 1000000);
        let minutes = Math.floor(totalSeconds / 60);
        let seconds = totalSeconds % 60;
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }

    destroy() {
        if (this._nameOwnerId) {
            Gio.DBus.session.signal_unsubscribe(this._nameOwnerId);
            this._nameOwnerId = null;
        }
        this._stopPositionPolling();

        for (let [busName, proxy] of this._proxies.entries()) {
            let handlerId = this._signalHandlerIds.get(busName);
            if (handlerId)
                proxy.disconnect(handlerId);
        }

        this._signalHandlerIds.clear();
        this._proxies.clear();
        this._lastChanged.clear();
        this._wave.destroy();
        super.destroy();
    }
});

export default class MusicFlowExtension extends Extension {
    enable() {
        this._indicator = new Indicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator.destroy();
        this._indicator = null;
    }
}
