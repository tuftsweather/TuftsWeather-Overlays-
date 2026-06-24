export type OverlayStatus = 'Ready' | 'Draft' | 'Offline'

export type OverlayCard = {
  name: string
  route: string
  status: OverlayStatus
  note: string
}

export type ServiceSnapshot = {
  mode: string
  connected: boolean
  activeEvents: number
  tornadoWarningCount: number
  severeWarningCount: number
  highestLabel: string
  lastMessage: string
  lastEventAt: string
  configPath: string
  baseUrl: string
  warningBannerUrl: string
  alertCounterUrl: string
  warningOutlineUrl: string
  popupAlertsUrl: string
  tropicalPopupAlertsUrl: string
  activeWarningStripUrl: string
  warnedCamsUrl: string
  streamUrl: string
}

export const overlayCards: OverlayCard[] = [
  {
    name: 'Primary Banner',
    route: '/overlays/weather-warning-banner.html',
    status: 'Ready',
    note: 'Highest-priority severe or tornado banner for browser and OBS scenes.',
  },
  {
    name: 'Alert Counter',
    route: '/overlays/alertactive.html',
    status: 'Ready',
    note: 'Live tornado and severe thunderstorm warning totals.',
  },
  {
    name: 'Tropical Counter',
    route: '/overlays/tropicalactive.html',
    status: 'Ready',
    note: 'Counts active tornado, hurricane, and tropical storm warning/watch products.',
  },
  {
    name: 'Tropical Banner',
    route: '/overlays/tropical-banner.html',
    status: 'Ready',
    note: 'Highest active Atlantic tropical system banner using the primary banner layout.',
  },
  {
    name: 'Tropical Popup Alerts',
    route: '/overlays/tropical-popup-alerts.html?setMaxHistory=2',
    status: 'Ready',
    note: 'New and updated tropical warning and watch popups.',
  },
  {
    name: 'Warning Outline',
    route: '/overlays/weather-warning-outline.html',
    status: 'Ready',
    note: 'Scene outline that swaps color with the top alert level.',
  },
  {
    name: 'Popup Alerts',
    route: '/overlays/popup-alerts.html?setMaxHistory=2&setBeepVolume=0&setAlertVolume=0',
    status: 'Ready',
    note: 'New and updated alert popups styled for local use with audio muted.',
  },
  {
    name: 'Active Warning Strip',
    route: '/overlays/active-warning-strip.html',
    status: 'Ready',
    note: 'Bottom warning strip cycling active tornado, severe, watch, and flood alerts.',
  },
  {
    name: 'Date Overlay',
    route: '/overlays/date-overlay.html',
    status: 'Ready',
    note: "Simple white outlined text showing today's date.",
  },
  {
    name: 'SPC Outlook Box',
    route: '/overlays/spc-outlook-box.html',
    status: 'Ready',
    note: 'Rotates SPC day 1-8 outlooks every 10 seconds.',
  },
  {
    name: 'SPC Outlook Map',
    route: '/overlays/spc-outlook-map.html',
    status: 'Ready',
    note: 'Rotates the actual SPC outlook polygons on a map view.',
  },
  {
    name: 'Warned Cams',
    route: '/widgets/warnedcams',
    status: 'Ready',
    note: 'Cycles camera feeds that fall inside live warning polygons.',
  },
  {
    name: 'Tropical Outline',
    route: '/overlays/tropical-outline.html',
    status: 'Ready',
    note: 'Atlantic tropical scene outline that changes color by the highest active storm intensity.',
  },
  {
    name: 'Atlantic Latest',
    route: '/overlays/atlantic-latest-overlay.html',
    status: 'Ready',
    note: 'Latest official Atlantic tropical system ticker fed from NHC active storm data.',
  },
  {
    name: 'Tropical Warning Strip',
    route: '/overlays/tropical-active-strip.html',
    status: 'Ready',
    note: 'Bottom strip for tornado, hurricane, and tropical storm warning/watch products.',
  },
  {
    name: 'Tropical Cams',
    route: '/widgets/warnedcams-tropical',
    status: 'Ready',
    note: 'Cycles cameras nearest to active Atlantic tropical systems using the live NHC feed.',
  },
  {
    name: 'Winter Banner',
    route: '/overlays/winter-banner.html',
    status: 'Ready',
    note: 'Highest active winter storm or blizzard banner with local time.',
  },
  {
    name: 'Winter Counter',
    route: '/overlays/winter-alert-counter.html',
    status: 'Ready',
    note: 'Counts winter storm warning/watch and blizzard warning/watch products.',
  },
  {
    name: 'Winter Outline',
    route: '/overlays/winter-outline.html',
    status: 'Ready',
    note: 'Scene outline that follows the highest active winter alert color.',
  },
  {
    name: 'Winter Popup Alerts',
    route: '/overlays/winter-popup-alerts.html?setMaxHistory=2',
    status: 'Ready',
    note: 'New and updated winter alert popups for local winter scenes.',
  },
  {
    name: 'Winter Warning Strip',
    route: '/overlays/winter-active-strip.html',
    status: 'Ready',
    note: 'Cycling winter warning bar for blizzard and winter storm alerts.',
  },
  {
    name: 'Winter Cams',
    route: '/widgets/warnedcams-winter',
    status: 'Ready',
    note: 'Camera widget filtered to winter storm and blizzard warning polygons.',
  },
  {
    name: 'Lower Third',
    route: '/overlays/lower-third',
    status: 'Draft',
    note: 'Reserved for custom labels, places, and live scene callouts.',
  },
  {
    name: 'Starting Soon',
    route: '/overlays/starting-soon',
    status: 'Draft',
    note: 'Reserved slot for preshow timer and standby scenes.',
  },
]

export const fallbackServiceSnapshot: ServiceSnapshot = {
  mode: 'offline',
  connected: false,
  activeEvents: 0,
  tornadoWarningCount: 0,
  severeWarningCount: 0,
  highestLabel: 'No Severe Warnings',
  lastMessage: 'TuftsWeather Overlays service not running',
  lastEventAt: '',
  configPath: 'config/localoverlays.local.json',
  baseUrl: 'http://127.0.0.1:4318',
  warningBannerUrl: 'http://127.0.0.1:4318/overlays/weather-warning-banner.html',
  alertCounterUrl: 'http://127.0.0.1:4318/overlays/alertactive.html',
  warningOutlineUrl: 'http://127.0.0.1:4318/overlays/weather-warning-outline.html',
  popupAlertsUrl: 'http://127.0.0.1:4318/overlays/popup-alerts.html?setMaxHistory=2&setBeepVolume=0&setAlertVolume=0',
  tropicalPopupAlertsUrl: 'http://127.0.0.1:4318/overlays/tropical-popup-alerts.html?setMaxHistory=2',
  activeWarningStripUrl: 'http://127.0.0.1:4318/overlays/active-warning-strip.html',
  warnedCamsUrl: 'http://127.0.0.1:4318/widgets/warnedcams',
  streamUrl: 'ws://127.0.0.1:4318/stream',
}
