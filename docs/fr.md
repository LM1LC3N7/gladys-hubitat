# Hubitat Elevation

Cette intégration relie Gladys à **votre hub Hubitat Elevation** par son app
**Maker API**, et propose les appareils que vous y autorisez dans l'onglet
**Découverte** de Gladys : interrupteurs, variateurs, ampoules couleur et
blanches, prises avec leur consommation, volets, thermostats, serrures, portes
de garage, boutons et capteurs. Une fois un appareil ajouté, son état suit le
hub **en direct**, et Gladys le pilote **à travers le hub**, qui garde ses
appareils Z-Wave, Zigbee, Matter et réseau. Tout reste sur votre réseau local.
Non officiel, sans lien avec Hubitat.

> **Version de développement (0.1).** Écrite à partir de la documentation de
> la Maker API et de l'intégration Home Assistant de la même API, et testée
> contre un hub simulé : elle n'a jamais été testée sur un vrai hub Hubitat
> pour l'instant. Vos retours sont les bienvenus sur le dépôt GitHub.

## Ce que vous obtenez

| Capability Hubitat                                                | Dans Gladys                                                          |
| ----------------------------------------------------------------- | -------------------------------------------------------------------- |
| `Switch`, `SwitchLevel`                                           | une lumière (ampoules, variateurs), sinon un interrupteur (prises)   |
| `ColorControl`, `ColorTemperature` (`colorMode`)                  | couleur (RVB) et température de couleur, celle qu'affiche l'ampoule  |
| `PowerMeter`, `EnergyMeter`, `VoltageMeasurement`, `CurrentMeter` | puissance, énergie (compteur), tension et courant                    |
| `WindowShade`, `WindowBlind`                                      | un volet : ouvrir, fermer, arrêter, position                         |
| `Thermostat` (consignes chauffage et froid, mode, activité)       | un thermostat, consignes en °C                                       |
| `Lock`                                                            | une serrure, **en lecture seule tant que vous ne l'autorisez pas**   |
| `GarageDoorControl`, `DoorControl`                                | un capteur de porte, et une commande **en lecture seule par défaut** |
| `PushableButton`, `HoldableButton`, `DoubleTapableButton`…        | un bouton par numéro : appui, double appui, appui long, relâché      |
| `ContactSensor`, `MotionSensor`, `WaterSensor`                    | détecteurs d'ouverture, de mouvement et de fuite                     |
| `SmokeDetector`, `CarbonMonoxideDetector`, `TamperAlert`          | détecteurs de fumée, de CO et de sabotage                            |
| `TemperatureMeasurement`, `RelativeHumidityMeasurement`           | température (°C) et humidité                                         |
| `IlluminanceMeasurement`, `CarbonDioxideMeasurement`, `Battery`…  | luminosité, CO2, indice UV, batterie, présence                       |

Chaque appareil du hub donne **un appareil Gladys**, nommé d'après son libellé
et sa pièce (« Plafonnier (Salon) ») ; son identifiant sur le hub, sa pièce et
son driver sont gardés dans ses paramètres. Les appareils sans aucune de ces
capabilities (enceintes, pour l'instant) sont écartés. Les vannes d'eau ne sont
pas pilotées. L'interrupteur d'un appareil qui est aussi une serrure, une porte
de garage, une vanne, une sirène ou un clavier d'alarme est affiché en lecture
seule, quelles que soient les options : une scène « tout éteindre » ne
l'atteint jamais.

## Prérequis

- Un hub Hubitat Elevation (C-5, C-7, C-8 ou plus récent) sur le même réseau
  local que Gladys.
- L'app **Maker API** installée sur le hub (intégrée).

## Installation

1. Dans l'interface web de Hubitat, **Apps → Add Built-In App → Maker API**.
   Sélectionnez les appareils que Gladys peut voir et piloter, puis **Done**.
   Laissez « Allow Access via Remote / Cloud » désactivé : Gladys utilise les
   adresses locales.
2. Rouvrez l'app Maker API : sa page affiche des URL du type
   `http://192.168.1.50/apps/api/12/devices?access_token=…`. Notez :
   - l'**adresse** du hub (`192.168.1.50`),
   - le **numéro de l'app** (`12`, après `/apps/api/`),
   - le **jeton d'accès** (après `access_token=`).
3. Dans Gladys, ouvrez l'intégration, **Configuration**, et remplissez les trois
   champs. Vous pouvez coller une URL de la Maker API dans le champ adresse,
   sans son jeton : l'adresse et le numéro de l'app en sont tirés.
4. Cliquez sur **Tester la connexion** : le nombre d'appareils autorisés, les
   appareils proposés et le fonctionnement des événements en direct
   s'affichent.
5. Ouvrez l'onglet **Découverte** et ajoutez les appareils voulus. Leurs valeurs
   sont envoyées dès leur ajout.

## Options

- **Échelle de température du hub** : l'échelle réglée dans Hubitat (Settings →
  Location and modes). Gladys affiche toujours des °C et convertit ; quand le
  hub donne l'unité d'une mesure, c'est elle qui compte, et elle est gardée
  pour les lectures suivantes. Quand les unités du hub contredisent l'option,
  l'état de connexion le signale et les consignes de thermostat sont refusées.
  Une consigne est envoyée dans l'échelle de l'unité donnée par le hub quand
  elle est connue, sinon dans celle de cette option (avec ou sans événements
  en direct), et seulement si la consigne actuelle est connue et vraisemblable
  dans cette échelle : jusqu'à 35 en °C, à partir de 39 en °F. Un hub en °F
  réglé ici en °C est ainsi repéré.
- **Événements en direct** (activés par défaut) : l'intégration écoute le socket
  d'événements du hub (`ws://<hub>/eventsocket`). Les changements arrivent dans
  Gladys en une seconde, et les appuis sur les boutons arrivent à vos scènes.
  Désactivés, ou quand le socket est perdu, les appareils sont lus à
  l'intervalle ci-dessous.
- **Intervalle de lecture sans événements en direct** : 30 secondes par défaut
  (10 à 3600). Avec les événements, la liste complète est relue toutes les
  5 minutes de toute façon.
- **Intervalle minimum entre deux mesures d'un capteur** : 10 secondes par
  défaut (0 à 300). Une prise qui remonte sa puissance chaque seconde est
  envoyée à Gladys à ce rythme. Interrupteurs, lumières, boutons, détecteurs de
  mouvement et d'ouverture ne sont jamais retardés.
- **Langue des noms des fonctionnalités** : français ou anglais, pour les
  appareils ajoutés désormais.
- **Autoriser le pilotage des serrures depuis Gladys** (désactivé par défaut) :
  voir Sécurité.
- **Autoriser le pilotage des portes de garage depuis Gladys** (désactivé par
  défaut) : voir Sécurité.

## Sécurité

- **Serrures et portes de garage sont en lecture seule par défaut.** Leur état
  s'affiche, mais toute commande est refusée tant que l'option correspondante
  n'est pas activée. Une fois activée, Gladys peut **déverrouiller** votre
  porte et **ouvrir** votre garage, depuis le tableau de bord, vos scènes et
  les assistants vocaux. La commande de la porte de garage fonctionne comme un
  volet (ouvrir 1, fermer -1 ; arrêt seulement si l'ouvre-porte a une commande
  d'arrêt) : une scène qui agit sur tous les volets l'atteint aussi.
- Avant une commande de serrure ou de porte de garage, l'intégration **relit
  l'appareil** sur le hub, et refuse si son état est inconnu ou en mouvement
  (ouverture, fermeture en cours) ; rien n'est envoyé s'il est déjà dans
  l'état voulu.
- Après la commande, l'appareil est **sous garde** : toute autre commande de
  serrure ou de porte de garage sur lui est refusée (« une commande est déjà
  en cours ») jusqu'à ce qu'il signale l'état demandé, ou pendant 20 secondes
  (serrure) / 60 secondes (porte de garage). Un rapport tardif de l'ancien
  état ou un état inconnu ne lève jamais la garde. Arrêter une porte de garage
  en mouvement (si l'ouvre-porte a une commande d'arrêt) reste possible
  pendant la garde. L'appareil est relu après
  5 et 15 secondes (et 30 et 60 pour une porte de garage) ; si ces lectures
  échouent, ou si l'état n'arrive jamais, son badge indique « état non
  confirmé ».
- Les commandes d'un même appareil partent **une par une**. Gladys attend une
  réponse 5 secondes : une commande qui n'a pas pu partir en 3,5 secondes est
  refusée, jamais envoyée en retard.
- L'intégration **ne modifie jamais l'alarme (HSM) ni les modes** du hub : elle
  ne contient aucune commande de ce type.

## Bon à savoir

- **Le hub reste maître des appareils** : Gladys envoie ses commandes à la
  Maker API, qui les pilote. Gardez le hub allumé.
- **Boutons** : chaque numéro de bouton est une fonctionnalité (`Bouton 1`,
  `Bouton 2`…). Un appui est un clic, un double appui un double clic, un appui
  maintenu un appui long, le relâchement sa fin (un relâchement sans appui
  maintenu avant est un simple « relâché »). Les appuis n'arrivent que par
  les événements en direct : sans eux, les boutons restent muets.
- **Chien de garde des événements en direct** : quand une lecture complète
  trouve un changement d'un état à deux valeurs (interrupteur, contact,
  mouvement, serrure, porte…) qu'aucun événement n'a annoncé, ou quand le
  socket est resté muet 30 minutes, il est rouvert aussitôt ; les badges ne
  passent à l'orange que si cette réouverture échoue.
- **Énergie** : Gladys compte chaque hausse de l'index d'énergie en entier
  dans l'onglet Énergie. L'intégration ne publie donc jamais 0, et retient
  toute valeur anormale : une baisse, ou un saut de plus de 25 kW en moyenne
  depuis la dernière valeur acceptée (plus 0,5 kWh de marge). Pendant une
  retenue, la dernière valeur acceptée est renvoyée, le badge de l'appareil
  passe à l'orange avec le saut ou la baisse et les kWh en jeu, et le journal
  le signale. Ni la répétition, ni le temps, ni une nouvelle hausse, ni un
  enregistrement de la configuration, ni une reconnexion ne l'acceptent :
  seul le bouton **Accepter l'index retenu** de la configuration le fait, et
  il prend exactement la valeur affichée (plus ce que l'appareil a pu
  consommer depuis) en répondant avec les kWh comptés. Un saut accepté est
  compté d'un coup comme consommation ; une baisse acceptée (compteur remis à
  zéro par `resetEnergy`) ne facture rien. Une valeur revenue à la normale
  lève la retenue. La retenue est gardée dans `/data` et survit à un
  redémarrage ; créer l'appareil (à nouveau) repart de zéro. Un driver qui
  donne des Wh est converti en kWh.
- **Le socket d'événements transporte les événements de tous les appareils du
  hub**, pas seulement de ceux que vous avez autorisés : l'intégration garde
  les autorisés et ignore les autres. Il ne demande pas de jeton.
- **Contacts de porte** : Gladys affiche 0 pour ouvert et 1 pour fermé ;
  l'intégration convertit.
- **Badge de transport** : un appareil passe « injoignable » quand le hub l'est,
  ou quand Hubitat le signale hors ligne (`healthStatus`) ; un point orange
  signifie que les événements en direct sont perdus et que l'état est lu à
  l'intervalle configuré.
- **Les appareils autorisés plus tard** dans la Maker API apparaissent dans
  Découverte à la lecture complète suivante (5 minutes au plus). Le bouton
  **Scanner** les lit tout de suite.

## Dépannage

| Message d'état                                | Que faire                                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| La Maker API a refusé le jeton d'accès        | Recopiez le jeton depuis la page de l'app Maker API.                                          |
| Aucune app Maker API ne répond avec ce numéro | Vérifiez le numéro de l'app, après `/apps/api/` dans ses URL.                                 |
| Le hub Hubitat est injoignable                | Vérifiez l'adresse, vue depuis la machine Gladys (pas `localhost`), et que le hub est allumé. |
| L'adresse contient le jeton d'accès           | Ne laissez que l'adresse du hub dans ce champ, et collez le jeton dans son propre champ.      |
| Pas d'événements en direct du hub             | Gladys lit les appareils à l'intervalle configuré en attendant, et réessaie toute seule.      |

Les logs de l'intégration (Gladys, page de l'intégration) donnent les détails.

## Confidentialité

Tout reste sur votre réseau local : l'intégration ne parle qu'à votre hub, par
la Maker API et son socket d'événements. Le jeton d'accès est gardé par Gladys
dans sa base, jamais réaffiché, et envoyé seulement à votre hub ; il n'est
jamais écrit dans les logs. Hubitat et Hubitat Elevation sont des marques de
Hubitat, Inc. ; cette intégration est sans lien avec Hubitat.
