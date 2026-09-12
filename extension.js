import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_OBJECT_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, _('Music Flow'));

        this._label = new St.Label({
            text: _('No music playing'),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._label);

        this._proxies = new Map();
        this._lastChanged = new Map();
        this._activeProxy = null;

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
                    this._proxies.delete(name);
                    this._lastChanged.delete(name);
                    this._pickActivePlayer();
                } else if (oldOwner === '') {
                    this._connectToPlayer(name);
                }
            }
        );

        this._discoverExistingPlayers();
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

                proxy.connect('g-properties-changed', () => {
                    this._lastChanged.set(busName, Date.now());
                    this._pickActivePlayer();
                });

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
            this._updateLabel(this._activeProxy);
            this._updatePlayPauseIcon(true);
            return;
        }

        for (let proxy of this._proxies.values()) {
            let status = proxy.get_cached_property('PlaybackStatus');
            if (status && status.deep_unpack() === 'Paused') {
                this._activeProxy = proxy;
                this._updateLabel(proxy);
                this._updatePlayPauseIcon(false);
                return;
            }
        }

        this._activeProxy = null;
        this._updateLabel(null);
        this._updatePlayPauseIcon(false);
    }

    _updatePlayPauseIcon(isPlaying) {
        let icon = this._playPauseButton.get_child();
        icon.icon_name = isPlaying
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';
    }

    _updateLabel(proxy) {
        if (!proxy) {
            this._label.set_text(_('No music playing'));
            return;
        }

        let metadata = proxy.get_cached_property('Metadata');
        if (!metadata) {
            this._label.set_text(_('No music playing'));
            return;
        }

        let dict = metadata.deep_unpack();
        let title = dict['xesam:title'] ? dict['xesam:title'].deep_unpack() : 'Unknown title';
        let artistArr = dict['xesam:artist'] ? dict['xesam:artist'].deep_unpack() : ['Unknown artist'];
        let artist = artistArr[0] || 'Unknown artist';

        this._label.set_text(`${title} — ${artist}`);
    }

    destroy() {
        if (this._nameOwnerId) {
            Gio.DBus.session.signal_unsubscribe(this._nameOwnerId);
            this._nameOwnerId = null;
        }
        this._proxies.clear();
        this._lastChanged.clear();
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
