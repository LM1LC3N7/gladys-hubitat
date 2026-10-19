// -----------------------------------------------------------------------------
// Texts shown in Gladys (connection status, button, badges, refusals, feature
// names), in English and French. Never put the access token in one of them.
// -----------------------------------------------------------------------------

import { LIMITS } from './constants.js';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Feature names ("Device – <label>"), by feature key. */
const LABELS = {
  level: { en: 'Brightness', fr: 'Luminosité' },
  color: { en: 'Colour', fr: 'Couleur' },
  colorTemperature: { en: 'Colour temperature', fr: 'Température de couleur' },
  position: { en: 'Position', fr: 'Position' },
  door: { en: 'Door', fr: 'Porte' },
  door_command: { en: 'Door command', fr: 'Commande de la porte' },
  heatingSetpoint: { en: 'Heating setpoint', fr: 'Consigne de chauffage' },
  coolingSetpoint: { en: 'Cooling setpoint', fr: 'Consigne de refroidissement' },
  thermostatMode: { en: 'Mode', fr: 'Mode' },
  thermostatOperatingState: { en: 'Activity', fr: 'Activité' },
  temperature: { en: 'Temperature', fr: 'Température' },
  humidity: { en: 'Humidity', fr: 'Humidité' },
  illuminance: { en: 'Illuminance', fr: 'Luminosité ambiante' },
  carbonDioxide: { en: 'CO2', fr: 'CO2' },
  ultravioletIndex: { en: 'UV index', fr: 'Indice UV' },
  voltage: { en: 'Voltage', fr: 'Tension' },
  amperage: { en: 'Current', fr: 'Courant' },
  battery: { en: 'Battery', fr: 'Batterie' },
  power: { en: 'Power', fr: 'Puissance' },
  energy: { en: 'Energy', fr: 'Énergie' },
  contact: { en: 'Opening', fr: 'Ouverture' },
  motion: { en: 'Motion', fr: 'Mouvement' },
  water: { en: 'Water leak', fr: "Fuite d'eau" },
  smoke: { en: 'Smoke', fr: 'Fumée' },
  carbonMonoxide: { en: 'Carbon monoxide', fr: 'Monoxyde de carbone' },
  tamper: { en: 'Tamper', fr: 'Sabotage' },
  presence: { en: 'Presence', fr: 'Présence' },
  button: { en: 'Button', fr: 'Bouton' },
  buttonN: { en: 'Button {n}', fr: 'Bouton {n}' },
};

/** The label of a feature key in a language ("Button 2"). */
export function label(key, language = 'fr', n) {
  const text = LABELS[key]?.[language] ?? LABELS[key]?.en ?? key;
  return text.replace('{n}', String(n ?? ''));
}

/** One text of a { en, fr } pair, in a language. */
export const word = (pair, language = 'fr') => pair?.[language] ?? pair?.en ?? '';

const trim = (text) =>
  text.length > LIMITS.badgeMessage ? `${text.slice(0, LIMITS.badgeMessage - 1)}…` : text;

/** kWh shown: three decimals at most. */
const kwh = (n) => Math.round(n * 1000) / 1000;

/** The kWh an accepted hold counts: the jump, 0 for a drop. */
const counted = ({ direction, from, to }) => (direction === 'up' ? kwh(to - from) : 0);

/** kWh shown in French: a decimal comma (312,4). */
const kwhFr = (n) => String(kwh(n)).replace('.', ',');

/** Holds listed in the answer of the action (the others are counted, not named). */
const LISTED = 5;

/** The holds of an answer: the first LISTED named, with their kWh, and the total. */
function listed(holds) {
  const total = kwh(holds.reduce((sum, h) => sum + counted(h), 0));
  const shown = holds.slice(0, LISTED);
  return {
    total,
    more: holds.length - shown.length,
    en: shown
      .map((h) => `${h.name}: ${kwh(h.from)} → ${kwh(h.to)} kWh (${counted(h)} kWh)`)
      .join('; '),
    fr: shown
      .map((h) => `${h.name} : ${kwhFr(h.from)} → ${kwhFr(h.to)} kWh (${kwhFr(counted(h))} kWh)`)
      .join(' ; '),
  };
}

/** Why the hub is unreachable, with the hint that fits. */
function unreachable(err) {
  const reason = err?.message ?? 'unknown error';
  const hints = {
    certificate: {
      en: 'Use the plain address of the hub: http:// and its IP address.',
      fr: "Utilisez l'adresse simple du hub : http:// et son adresse IP.",
    },
    redirect: {
      en: 'Type the IP address of the hub, like 192.168.1.50, and check the app number of the Maker API.',
      fr: "Saisissez l'adresse IP du hub, par exemple 192.168.1.50, et vérifiez le numéro de l'app Maker API.",
    },
    format: {
      en: 'Is it the IP address of your Hubitat hub, and the number of its Maker API app?',
      fr: "Est-ce bien l'adresse IP de votre hub Hubitat, et le numéro de son app Maker API ?",
    },
  };
  const hint = hints[err?.kind] ?? {
    en: 'Check its IP address (not localhost) and that it is on. Retrying in a few seconds.',
    fr: 'Vérifiez son adresse IP (pas localhost) et qu’il est allumé. Nouvel essai dans quelques secondes.',
  };
  return {
    en: `The Hubitat hub is unreachable: ${reason}. ${hint.en}`,
    fr: `Le hub Hubitat est injoignable : ${reason}. ${hint.fr}`,
  };
}

/** Why the live events are missing. */
function liveReason(err) {
  return {
    en: `No live events from the hub (${err?.message ?? 'unknown error'}), retrying.`,
    fr: `Pas d'événements en direct du hub (${err?.message ?? 'erreur inconnue'}), nouvel essai.`,
  };
}

export const T = {
  configError(error) {
    switch (error) {
      case 'empty':
        return {
          en: 'Type the IP address of your Hubitat hub in the configuration, like 192.168.1.50.',
          fr: "Saisissez l'adresse IP de votre hub Hubitat dans la configuration, par exemple 192.168.1.50.",
        };
      case 'no-app':
      case 'bad-app':
        return {
          en: 'Type the number of the Maker API app (Apps → Maker API: the number after /apps/api/ in its URLs).',
          fr: "Saisissez le numéro de l'app Maker API (Apps → Maker API : le nombre après /apps/api/ dans ses URL).",
        };
      case 'no-token':
        return {
          en: 'Paste the access token of the Maker API app in the configuration.',
          fr: "Collez le jeton d'accès de l'app Maker API dans la configuration.",
        };
      case 'token-in-address':
        return {
          en: 'The address contains the access token: keep only the IP address of the hub there, and paste the token in its own field.',
          fr: "L'adresse contient le jeton d'accès : n'y laissez que l'adresse IP du hub, et collez le jeton dans son propre champ.",
        };
      case 'cloud':
        return {
          en: 'cloud.hubitat.com is the cloud relay: type the local IP address of the hub, like 192.168.1.50.',
          fr: "cloud.hubitat.com est le relais cloud : saisissez l'adresse IP locale du hub, par exemple 192.168.1.50.",
        };
      case 'credentials':
        return {
          en: 'No user name or password in the address: the Maker API uses its access token.',
          fr: "Pas d'utilisateur ni de mot de passe dans l'adresse : la Maker API utilise son jeton d'accès.",
        };
      case 'local-name':
        return {
          en: 'Names ending in .local cannot be reached from the integration: type the IP address of the hub.',
          fr: "Les noms en .local ne sont pas joignables depuis l'intégration : saisissez l'adresse IP du hub.",
        };
      default:
        return {
          en: 'The address of the hub is not valid: type its IP address, like 192.168.1.50.',
          fr: "L'adresse du hub n'est pas valide : saisissez son adresse IP, par exemple 192.168.1.50.",
        };
    }
  },
  connecting: { en: 'Connecting to the Hubitat hub…', fr: 'Connexion au hub Hubitat…' },
  /**
   * @param {number} devices offered in Discovery
   * @param {'off'|'connecting'|'live'|'down'} live the live events
   * @param {Error} [liveError] why they are down
   * @param {number} pollSeconds the pace of the reads without them
   */
  connected(devices, live, liveError, pollSeconds) {
    const base = {
      en: `Connected to the Hubitat hub: ${plural(devices, 'device', 'devices')} in Discovery.`,
      fr: `Connecté au hub Hubitat : ${plural(devices, 'appareil', 'appareils')} dans Découverte.`,
    };
    if (live === 'live') {
      return { en: `${base.en} Live events on.`, fr: `${base.fr} Événements en direct actifs.` };
    }
    if (live === 'off') {
      return {
        en: `${base.en} Live events off: the devices are read every ${pollSeconds} s.`,
        fr: `${base.fr} Événements en direct désactivés : les appareils sont lus toutes les ${pollSeconds} s.`,
      };
    }
    if (live === 'down') {
      const why = liveReason(liveError);
      return {
        en: `${base.en} ${why.en} Meanwhile the devices are read every ${pollSeconds} s.`,
        fr: `${base.fr} ${why.fr} En attendant, les appareils sont lus toutes les ${pollSeconds} s.`,
      };
    }
    return base;
  },
  /** The status of a failed call (a HubitatError). */
  failure(err) {
    switch (err?.kind) {
      case 'auth':
        return {
          en: 'The Maker API refused the access token: copy it again from the Maker API app page and paste it in the configuration.',
          fr: "La Maker API a refusé le jeton d'accès : recopiez-le depuis la page de l'app Maker API et collez-le dans la configuration.",
        };
      case 'notfound':
        return {
          en: 'No Maker API app answers with this number: check the app number (the number after /apps/api/ in its URLs).',
          fr: "Aucune app Maker API ne répond avec ce numéro : vérifiez le numéro de l'app (le nombre après /apps/api/ dans ses URL).",
        };
      case 'rate':
        return {
          en: 'The hub asks to slow down (too many requests): the integration pauses before trying again.',
          fr: "Le hub demande de ralentir (trop de requêtes) : l'intégration fait une pause avant de réessayer.",
        };
      case 'api':
        return {
          en: `The hub answered with an error: ${err.message}.`,
          fr: `Le hub a répondu par une erreur : ${err.message}.`,
        };
      default:
        return unreachable(err);
    }
  },
  test: {
    ok: ({ url, appId, total, devices, empty, live }) => {
      const liveText = !live
        ? { en: 'Live events: off in the configuration.', fr: 'Événements en direct : désactivés.' }
        : live.ok
          ? { en: 'Live events: OK.', fr: 'Événements en direct : OK.' }
          : liveReason(live.error);
      return {
        en:
          `Connection OK, Maker API app ${appId} at ${url}: ${plural(total, 'authorized device', 'authorized devices')}, ` +
          `${plural(devices, 'device', 'devices')} offered in Discovery` +
          (empty > 0 ? `, ${empty} left out (nothing Gladys can show yet). ` : '. ') +
          liveText.en,
        fr:
          `Connexion OK, app Maker API ${appId} à ${url} : ${plural(total, 'appareil autorisé', 'appareils autorisés')}, ` +
          `${plural(devices, 'appareil proposé', 'appareils proposés')} dans Découverte` +
          (empty > 0
            ? `, ${empty} écarté${empty === 1 ? '' : 's'} (rien que Gladys sache afficher pour l'instant). `
            : '. ') +
          liveText.fr,
      };
    },
  },
  badge: {
    noLive: (seconds) => ({
      en: trim(`No live events from the hub: the state is read every ${seconds} seconds.`),
      fr: trim(`Pas d'événements en direct du hub : l'état est lu toutes les ${seconds} secondes.`),
    }),
    offline: {
      en: 'Hubitat reports this device offline.',
      fr: 'Hubitat indique que cet appareil est hors ligne.',
    },
    unconfirmed: {
      en: 'State not confirmed after the last command: the device could not be read back.',
      fr: "État non confirmé après la dernière commande : l'appareil n'a pas pu être relu.",
    },
    /** An energy index held back (src/guard.js). */
    held: ({ direction, from, to }) =>
      direction === 'down'
        ? {
            en: trim(
              `Energy index held back: it dropped from ${kwh(from)} to ${kwh(to)} kWh. "Accept the held index" (configuration, two clicks) takes it, 0 kWh billed.`,
            ),
            fr: trim(
              `Index d'énergie retenu : baisse de ${kwhFr(from)} à ${kwhFr(to)} kWh. « Accepter l'index retenu » (configuration, deux clics) la prend, 0 kWh facturé.`,
            ),
          }
        : {
            en: trim(
              `Energy index held back: it jumped from ${kwh(from)} to ${kwh(to)} kWh. "Accept the held index" (configuration, two clicks) would count ${kwh(to - from)} kWh at once.`,
            ),
            fr: trim(
              `Index d'énergie retenu : saut de ${kwhFr(from)} à ${kwhFr(to)} kWh. « Accepter l'index retenu » (configuration, deux clics) compterait ${kwhFr(to - from)} kWh d'un coup.`,
            ),
          },
  },
  /** The answers of the "Accept the held index" action. */
  accept: {
    nothing: {
      en: 'No energy index is held back: nothing to accept.',
      fr: "Aucun index d'énergie n'est retenu : rien à accepter.",
    },
    /** First click: the holds and their kWh, nothing accepted. @param {Array<{ name, direction, from, to }>} holds */
    confirm(holds) {
      const { total, more, en, fr } = listed(holds);
      return {
        en:
          `Nothing accepted yet. Held back (${plural(holds.length, 'index', 'indexes')}): ${en}` +
          (more > 0 ? `; and ${more} more` : '') +
          `. Accepting would count ${total} kWh at once as consumption; a drop bills nothing. If these values are right, click "Accept the held index" again within 2 minutes.`,
        fr:
          `Rien n'est encore accepté. Retenu (${plural(holds.length, 'index', 'index')}) : ${fr}` +
          (more > 0 ? ` ; et ${more} autre${more === 1 ? '' : 's'}` : '') +
          `. Accepter compterait ${kwhFr(total)} kWh d'un coup comme consommation ; une baisse ne facture rien. Si ces valeurs sont justes, cliquez à nouveau sur « Accepter l'index retenu » dans les 2 minutes.`,
      };
    },
    /** Second click: what was taken. @param {Array<{ name, direction, from, to }>} accepted */
    done(accepted) {
      const { total, more, en, fr } = listed(accepted);
      return {
        en:
          `Accepted (${plural(accepted.length, 'index', 'indexes')}): ${en}` +
          (more > 0 ? `; and ${more} more` : '') +
          `. ${total} kWh will be counted at once as consumption (plus what the devices use meanwhile); a drop bills nothing. A different value stays held.`,
        fr:
          `Accepté (${plural(accepted.length, 'index', 'index')}) : ${fr}` +
          (more > 0 ? ` ; et ${more} autre${more === 1 ? '' : 's'}` : '') +
          `. ${kwhFr(total)} kWh seront comptés d'un coup comme consommation (plus ce que les appareils consomment d'ici là) ; une baisse ne facture rien. Une autre valeur reste retenue.`,
      };
    },
  },
  /** Refusals of a command, by key. */
  denied: {
    notConnected: {
      en: 'The Hubitat hub is not connected.',
      fr: "Le hub Hubitat n'est pas connecté.",
    },
    notCommand: {
      en: 'This feature cannot be controlled.',
      fr: 'Cette fonctionnalité ne peut pas être pilotée.',
    },
    unsupported: {
      en: 'This device does not offer this command in Hubitat.',
      fr: 'Cet appareil ne propose pas cette commande dans Hubitat.',
    },
    badValue: { en: 'This value cannot be sent.', fr: 'Cette valeur ne peut pas être envoyée.' },
    lockOff: {
      en: 'Locks are read-only: turn on "Allow lock control" in the configuration of the integration.',
      fr: "Les serrures sont en lecture seule : activez « Autoriser le pilotage des serrures » dans la configuration de l'intégration.",
    },
    garageOff: {
      en: 'Garage doors are read-only: turn on "Allow garage door control" in the configuration of the integration.',
      fr: "Les portes de garage sont en lecture seule : activez « Autoriser le pilotage des portes de garage » dans la configuration de l'intégration.",
    },
    unknownState: {
      en: 'Refused: the state of the device could not be read just now.',
      fr: "Refusé : l'état de l'appareil n'a pas pu être lu à l'instant.",
    },
    moving: {
      en: 'Refused: the door is moving or its state is unknown.',
      fr: 'Refusé : la porte est en mouvement ou son état est inconnu.',
    },
    tooLate: {
      en: 'Refused: the hub took too long, the command was not sent.',
      fr: "Refusé : le hub a mis trop de temps, la commande n'a pas été envoyée.",
    },
    busy: {
      en: 'Refused: a command is already in progress on this device; wait until it reports its new state.',
      fr: "Refusé : une commande est déjà en cours sur cet appareil ; attendez qu'il signale son nouvel état.",
    },
    scaleUnknown: {
      en: 'Refused: the temperature scale of the hub is not confirmed (check the "Temperature scale of the hub" option and the live events).',
      fr: "Refusé : l'échelle de température du hub n'est pas confirmée (vérifiez l'option « Échelle de température du hub » et les événements en direct).",
    },
    paused: {
      en: 'Refused: the hub asked to slow down, the integration is paused.',
      fr: "Refusé : le hub a demandé de ralentir, l'intégration est en pause.",
    },
  },
};

/** The scale of the hub differs from the option (added to the connection status). */
export const scaleMismatch = (seen) => ({
  en: `The hub reports temperatures in °${seen}, unlike the "Temperature scale of the hub" option: check it.`,
  fr: `Le hub donne ses températures en °${seen}, contrairement à l'option « Échelle de température du hub » : vérifiez-la.`,
});
