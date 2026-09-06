import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
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

        this._proxy = null;
        this._currentBusName = null;

        this._watchForPlayers();
    }

    _watchForPlayers() {
        // Watch for any service name appearing/disappearing on the bus
        this._nameOwnerId = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus',
            'org.freedesktop.DBus',
            'NameOwnerChanged',
            '/org/freedesktop/DBus',
            null,
            Gio.DBusSignalFlags.NONE,
            (conn, sender, path, iface, signal, params) => {
                let [name] = params.deep_unpack();
                if (name.startsWith(MPRIS_PREFIX))
                    this._findActivePlayer();
            }
        );

        this._findActivePlayer();
    }

    _findActivePlayer() {
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
                let playerNames = names.filter(n => n.startsWith(MPRIS_PREFIX));

                if (playerNames.length === 0) {
                    this._currentBusName = null;
                    this._proxy = null;
                    this._label.set_text(_('No music playing'));
                    return;
                }

                // Just take the first one found for now
                let busName = playerNames[0];
                if (busName !== this._currentBusName) {
                    this._currentBusName = busName;
                    this._connectToPlayer(busName);
                }
            }
        );
    }

    _connectToPlayer(busName) {
        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SESSION,
            Gio.DBusProxyFlags.NONE,
            null,
            busName,
            MPRIS_OBJECT_PATH,
            MPRIS_PLAYER_IFACE,
            null,
            (source, res) => {
                try {
                    this._proxy = Gio.DBusProxy.new_for_bus_finish(res);
                } catch (e) {
                    logError(e, `Music Flow: failed to connect to ${busName}`);
                    return;
                }

                this._proxy.connect('g-properties-changed', () => {
                    this._updateLabel();
                });

                this._updateLabel();
            }
        );
    }

    _updateLabel() {
        if (!this._proxy)
            return;

        let metadata = this._proxy.get_cached_property('Metadata');
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
