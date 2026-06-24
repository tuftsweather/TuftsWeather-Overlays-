import { useEffect, useMemo, useState } from 'react'
import './App.css'
import {
  fallbackServiceSnapshot,
  overlayCards,
  type OverlayCard,
  type ServiceSnapshot,
} from './data/dashboard'

type EndpointItem = {
  label: string
  url: string
  note: string
}

type OverlayGroup = {
  title: string
  note: string
  overlays: Array<OverlayCard & { fullUrl: string }>
}

const testAlerts = [
  { key: 'tornado-emergency', label: 'Tornado Emergency' },
  { key: 'pds-tornado', label: 'PDS Tornado' },
  { key: 'observed-tornado', label: 'Observed Tornado' },
  { key: 'radar-tornado', label: 'Radar Tornado' },
  { key: 'tornado-watch', label: 'Tornado Watch' },
  { key: 'eds-severe', label: 'EDS Severe' },
  { key: 'destructive-severe', label: 'Destructive Severe' },
  { key: 'considerable-severe', label: 'Considerable Severe' },
  { key: 'severe-warning', label: 'Severe Warning' },
  { key: 'severe-watch', label: 'Severe Watch' },
  { key: 'flash-flood', label: 'Flash Flood' },
  { key: 'hurricane-warning', label: 'Hurricane Warning' },
  { key: 'hurricane-watch', label: 'Hurricane Watch' },
  { key: 'tropical-storm-warning', label: 'Tropical Storm Warning' },
  { key: 'tropical-storm-watch', label: 'Tropical Storm Watch' },
  { key: 'winter-storm-warning', label: 'Winter Storm Warning' },
  { key: 'winter-storm-watch', label: 'Winter Storm Watch' },
  { key: 'blizzard-warning', label: 'Blizzard Warning' },
  { key: 'blizzard-watch', label: 'Blizzard Watch' },
]

const tropicalSystemTests = [
  { key: 'tropical-depression', label: 'Tropical Depression' },
  { key: 'tropical-storm', label: 'Tropical Storm' },
  { key: 'cat-1', label: 'Cat 1 Hurricane' },
  { key: 'cat-3', label: 'Cat 3 Hurricane' },
  { key: 'cat-5', label: 'Cat 5 Hurricane' },
]

const stripTests = [
  { key: 'severe-warning', label: 'Severe Strip Test' },
  { key: 'hurricane-warning', label: 'Tropical Strip Test' },
  { key: 'blizzard-warning', label: 'Winter Strip Test' },
]

function formatMode(mode: string) {
  return mode.replace(/-/g, ' ')
}

function formatLastEvent(timestamp: string) {
  if (!timestamp) {
    return 'No live alert timestamp yet'
  }

  const value = Date.parse(timestamp)
  if (!Number.isFinite(value)) {
    return timestamp
  }

  return new Date(value).toLocaleString()
}

function classifyOverlayGroup(overlay: OverlayCard & { fullUrl: string }) {
  if (overlay.route.includes('winter')) {
    return 'winter'
  }
  if (overlay.route.includes('tropical')) {
    return 'tropical'
  }
  if (overlay.route.includes('/widgets/')) {
    return 'widgets'
  }
  return 'warnings'
}

function App() {
  const [service, setService] = useState<ServiceSnapshot>(fallbackServiceSnapshot)
  const [copiedUrl, setCopiedUrl] = useState('')
  const [testBusy, setTestBusy] = useState('')
  const [testMessage, setTestMessage] = useState('')

  useEffect(() => {
    let active = true

    const loadStatus = async () => {
      const baseUrl =
        window.location.port === '4173' ? 'http://127.0.0.1:4318' : ''

      try {
        const response = await fetch(`${baseUrl}/api/status`)
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }

        const payload = await response.json()
        if (!active) {
          return
        }

        setService({
          mode: payload.mode ?? 'offline',
          connected: Boolean(payload.connected),
          activeEvents: payload.summary?.activeCount ?? payload.activeEvents ?? 0,
          tornadoWarningCount: payload.summary?.tornadoWarningCount ?? 0,
          severeWarningCount: payload.summary?.severeWarningCount ?? 0,
          highestLabel:
            payload.summary?.highestLabel ?? fallbackServiceSnapshot.highestLabel,
          lastMessage: payload.lastMessage ?? 'Service online',
          lastEventAt: payload.lastEventAt ?? '',
          configPath:
            payload.config?.configPath ?? fallbackServiceSnapshot.configPath,
          baseUrl:
            payload.endpoints?.dashboard?.replace(/\/$/, '') ??
            fallbackServiceSnapshot.baseUrl,
          warningBannerUrl:
            payload.endpoints?.warningBanner ??
            fallbackServiceSnapshot.warningBannerUrl,
          alertCounterUrl:
            payload.endpoints?.alertCounter ??
            fallbackServiceSnapshot.alertCounterUrl,
          warningOutlineUrl:
            payload.endpoints?.warningOutline ??
            fallbackServiceSnapshot.warningOutlineUrl,
          popupAlertsUrl:
            payload.endpoints?.popupAlerts ??
            fallbackServiceSnapshot.popupAlertsUrl,
          activeWarningStripUrl:
            payload.endpoints?.activeWarningStrip ??
            fallbackServiceSnapshot.activeWarningStripUrl,
          warnedCamsUrl:
            payload.endpoints?.warnedCams ?? fallbackServiceSnapshot.warnedCamsUrl,
          streamUrl: payload.endpoints?.stream ?? fallbackServiceSnapshot.streamUrl,
        })
      } catch {
        if (active) {
          setService(fallbackServiceSnapshot)
        }
      }
    }

    void loadStatus()
    const timer = window.setInterval(() => {
      void loadStatus()
    }, 5000)

    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])

  const endpoints = useMemo<EndpointItem[]>(
    () => [
      {
        label: 'Primary Banner',
        url: service.warningBannerUrl,
        note: 'Highest active severe or tornado banner',
      },
      {
        label: 'Popup Alerts',
        url: service.popupAlertsUrl,
        note: 'New and updated local alert popup',
      },
      {
        label: 'Warning Strip',
        url: service.activeWarningStripUrl,
        note: 'Cycling active warning bar',
      },
      {
        label: 'Warned Cams',
        url: service.warnedCamsUrl,
        note: 'Camera widget inside live warning polygons',
      },
      {
        label: 'Alert Counter',
        url: service.alertCounterUrl,
        note: 'Tornado and severe warning totals',
      },
      {
        label: 'Warning Outline',
        url: service.warningOutlineUrl,
        note: 'Scene outline overlay',
      },
    ],
    [service],
  )

  const overlayRows = useMemo(
    () =>
      overlayCards
        .filter((overlay) => overlay.status !== 'Draft')
        .map((overlay) => ({
          ...overlay,
          fullUrl: `${service.baseUrl}${overlay.route}`,
        })),
    [service.baseUrl],
  )

  const overlayGroups = useMemo<OverlayGroup[]>(() => {
    const groups = {
      warnings: {
        title: 'Warning Overlays',
        note: 'Core severe, tornado, flood, and counter scenes.',
        overlays: [] as Array<OverlayCard & { fullUrl: string }>,
      },
      widgets: {
        title: 'Camera Widgets',
        note: 'Warned camera scenes and live camera tools.',
        overlays: [] as Array<OverlayCard & { fullUrl: string }>,
      },
      tropical: {
        title: 'Tropical Set',
        note: 'Atlantic storm scenes, counters, and tropical tools.',
        overlays: [] as Array<OverlayCard & { fullUrl: string }>,
      },
      winter: {
        title: 'Winter Set',
        note: 'Winter storm, blizzard, and cold-season alert scenes.',
        overlays: [] as Array<OverlayCard & { fullUrl: string }>,
      },
    }

    for (const overlay of overlayRows) {
      groups[classifyOverlayGroup(overlay)].overlays.push(overlay)
    }

    return Object.values(groups)
  }, [overlayRows])

  const featuredEndpoints = useMemo(
    () => endpoints.slice(0, 4),
    [endpoints],
  )

  const readyCount = overlayRows.filter((overlay) => overlay.status === 'Ready').length

  const draftCount = overlayRows.filter((overlay) => overlay.status === 'Draft').length

  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedUrl(value)
      window.setTimeout(() => {
        setCopiedUrl((current) => (current === value ? '' : current))
      }, 1600)
    } catch {
      setCopiedUrl('')
    }
  }

  async function refreshStatus() {
    const baseUrl =
      window.location.port === '4173' ? 'http://127.0.0.1:4318' : ''

    const response = await fetch(`${baseUrl}/api/status`)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    const payload = await response.json()
    setService({
      mode: payload.mode ?? 'offline',
      connected: Boolean(payload.connected),
      activeEvents: payload.summary?.activeCount ?? payload.activeEvents ?? 0,
      tornadoWarningCount: payload.summary?.tornadoWarningCount ?? 0,
      severeWarningCount: payload.summary?.severeWarningCount ?? 0,
      highestLabel:
        payload.summary?.highestLabel ?? fallbackServiceSnapshot.highestLabel,
      lastMessage: payload.lastMessage ?? 'Service online',
      lastEventAt: payload.lastEventAt ?? '',
      configPath:
        payload.config?.configPath ?? fallbackServiceSnapshot.configPath,
      baseUrl:
        payload.endpoints?.dashboard?.replace(/\/$/, '') ??
        fallbackServiceSnapshot.baseUrl,
      warningBannerUrl:
        payload.endpoints?.warningBanner ??
        fallbackServiceSnapshot.warningBannerUrl,
      alertCounterUrl:
        payload.endpoints?.alertCounter ??
        fallbackServiceSnapshot.alertCounterUrl,
      warningOutlineUrl:
        payload.endpoints?.warningOutline ??
        fallbackServiceSnapshot.warningOutlineUrl,
      popupAlertsUrl:
        payload.endpoints?.popupAlerts ??
        fallbackServiceSnapshot.popupAlertsUrl,
      activeWarningStripUrl:
        payload.endpoints?.activeWarningStrip ??
        fallbackServiceSnapshot.activeWarningStripUrl,
      warnedCamsUrl:
        payload.endpoints?.warnedCams ?? fallbackServiceSnapshot.warnedCamsUrl,
      streamUrl: payload.endpoints?.stream ?? fallbackServiceSnapshot.streamUrl,
    })
  }

  async function triggerTestAlert(type: string, label: string) {
    const baseUrl =
      window.location.port === '4173' ? 'http://127.0.0.1:4318' : ''

    setTestBusy(type)
    setTestMessage('')
    try {
      const response = await fetch(`${baseUrl}/api/test-alerts/${type}`, {
        method: 'POST',
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      await refreshStatus()
      setTestMessage(`${label} test alert is active`)
    } catch {
      setTestMessage('Test alert failed')
    } finally {
      setTestBusy('')
    }
  }

  async function clearTestAlerts() {
    const baseUrl =
      window.location.port === '4173' ? 'http://127.0.0.1:4318' : ''

    setTestBusy('clear')
    setTestMessage('')
    try {
      const response = await fetch(`${baseUrl}/api/test-alerts`, {
        method: 'DELETE',
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      await refreshStatus()
      setTestMessage('Test alerts cleared')
    } catch {
      setTestMessage('Clear failed')
    } finally {
      setTestBusy('')
    }
  }

  async function triggerTropicalSystemTest(key: string, label: string) {
    const baseUrl =
      window.location.port === '4173' ? 'http://127.0.0.1:4318' : ''

    setTestBusy(`tropical-${key}`)
    setTestMessage('')

    try {
      const response = await fetch(`${baseUrl}/api/test-tropical-system/${key}`, {
        method: 'POST',
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      await refreshStatus()
      setTestMessage(`${label} tropical banner test is active`)
    } catch {
      setTestMessage('Tropical test failed')
    } finally {
      setTestBusy('')
    }
  }

  async function clearTropicalSystemTest() {
    const baseUrl =
      window.location.port === '4173' ? 'http://127.0.0.1:4318' : ''

    setTestBusy('tropical-clear')
    setTestMessage('')

    try {
      const response = await fetch(`${baseUrl}/api/test-tropical-system`, {
        method: 'DELETE',
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      await refreshStatus()
      setTestMessage('Tropical banner test cleared')
    } catch {
      setTestMessage('Tropical clear failed')
    } finally {
      setTestBusy('')
    }
  }

  return (
    <main className="dashboard-shell">
      <section className="dashboard-hero">
        <div className="dashboard-hero__main">
          <p className="eyebrow">TuftsWeather Overlays Dashboard</p>
          <h1>Overlay Dashboard</h1>
          <p className="lede">
            Live status, launch links, and route management for your private
            overlay stack.
          </p>

          <div className="hero-actions">
            <a
              className="hero-action hero-action--primary"
              href={service.baseUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open Dashboard
            </a>
            <a
              className="hero-action"
              href={service.popupAlertsUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open Popup Alerts
            </a>
            <button
              className="hero-action hero-action--button"
              type="button"
              onClick={() => copyText(service.streamUrl)}
            >
              {copiedUrl === service.streamUrl ? 'Copied Stream URL' : 'Copy Stream URL'}
            </button>
          </div>
        </div>

        <article className="connection-card dashboard-hero__status">
          <span className={`status-pill ${service.connected ? 'live' : 'offline'}`}>
            {service.connected ? 'NWWS Connected' : 'Service Offline'}
          </span>
          <strong>{formatMode(service.mode)}</strong>
          <p>{service.lastMessage}</p>
          <div className="connection-card__meta">
            <span>{readyCount} ready routes</span>
            <span>{draftCount} draft routes</span>
          </div>
        </article>
      </section>

      <section className="summary-strip" aria-label="Service summary">
        <article className="summary-card summary-card--highlight">
          <span className="summary-card__label">Top Live Status</span>
          <strong>{service.highestLabel}</strong>
          <p>{service.lastMessage}</p>
        </article>
        <article className="summary-card">
              <span className="summary-card__label">Active Alerts</span>
              <strong>{service.activeEvents}</strong>
          <p>Current active warning products</p>
        </article>
        <article className="summary-card summary-card--tornado">
          <span className="summary-card__label">Tornado Warnings</span>
          <strong>{service.tornadoWarningCount}</strong>
          <p>Current live tornado warnings</p>
        </article>
        <article className="summary-card summary-card--severe">
          <span className="summary-card__label">Severe Warnings</span>
          <strong>{service.severeWarningCount}</strong>
          <p>Current severe thunderstorm warnings</p>
        </article>
      </section>

      <section className="launch-panel">
        <div className="panel-heading panel-heading--tight">
          <div>
            <p className="panel-kicker">Quick Open</p>
            <h2>Main Launches</h2>
          </div>
          <span className="panel-note">Fast scene links for OBS and browser tabs</span>
        </div>

        <div className="launch-grid">
          {featuredEndpoints.map((endpoint) => (
            <article key={endpoint.label} className="launch-card">
              <div className="launch-card__top">
                <span className="endpoint-label">{endpoint.label}</span>
                <button
                  className="mini-action"
                  type="button"
                  onClick={() => copyText(endpoint.url)}
                >
                  {copiedUrl === endpoint.url ? 'Copied' : 'Copy'}
                </button>
              </div>
              <p>{endpoint.note}</p>
              <a href={endpoint.url} target="_blank" rel="noreferrer">
                <code>{endpoint.url}</code>
              </a>
            </article>
          ))}
        </div>
      </section>

      <section className="test-panel">
        <div className="panel-heading panel-heading--tight">
          <div>
            <p className="panel-kicker">Test Mode</p>
            <h2>Preview Alert Types</h2>
          </div>
          <button
            className="mini-action"
            type="button"
            disabled={Boolean(testBusy)}
            onClick={clearTestAlerts}
          >
            {testBusy === 'clear' ? 'Clearing' : 'Clear Tests'}
          </button>
        </div>

        <div className="test-grid">
          {testAlerts.map((alert) => (
            <button
              key={alert.key}
              className="test-button"
              type="button"
              disabled={Boolean(testBusy)}
              onClick={() => triggerTestAlert(alert.key, alert.label)}
            >
              {testBusy === alert.key ? 'Loading...' : alert.label}
            </button>
          ))}
        </div>

        <p className="test-note">
          {testMessage || 'Test alerts are local only and can be cleared anytime.'}
        </p>
      </section>

      <section className="test-panel">
        <div className="panel-heading panel-heading--tight">
          <div>
            <p className="panel-kicker">Tropical Tests</p>
            <h2>Preview Tropical Banner</h2>
          </div>
          <button
            className="mini-action"
            type="button"
            disabled={Boolean(testBusy)}
            onClick={clearTropicalSystemTest}
          >
            {testBusy === 'tropical-clear' ? 'Clearing' : 'Clear Tropical'}
          </button>
        </div>

        <div className="test-grid">
          {tropicalSystemTests.map((system) => (
            <button
              key={system.key}
              className="test-button"
              type="button"
              disabled={Boolean(testBusy)}
              onClick={() => triggerTropicalSystemTest(system.key, system.label)}
            >
              {testBusy === `tropical-${system.key}` ? 'Loading...' : system.label}
            </button>
          ))}
        </div>
      </section>

      <section className="test-panel">
        <div className="panel-heading panel-heading--tight">
          <div>
            <p className="panel-kicker">Strip Tests</p>
            <h2>Preview Warning Strips</h2>
          </div>
          <button
            className="mini-action"
            type="button"
            disabled={Boolean(testBusy)}
            onClick={clearTestAlerts}
          >
            {testBusy === 'clear' ? 'Clearing' : 'Clear Strip Test'}
          </button>
        </div>

        <div className="test-grid">
          {stripTests.map((alert) => (
            <button
              key={alert.key}
              className="test-button"
              type="button"
              disabled={Boolean(testBusy)}
              onClick={() => triggerTestAlert(alert.key, alert.label)}
            >
              {testBusy === alert.key ? 'Loading...' : alert.label}
            </button>
          ))}
        </div>

        <p className="test-note">
          Severe tests show on the severe strip, tropical tests show on the tropical strip, and winter tests show on the winter strip and winter scenes.
        </p>
      </section>

      <section className="content-grid">
        <article className="panel panel--library">
          <div className="panel-heading">
            <div>
              <p className="panel-kicker">Overlay Library</p>
              <h2>All Routes</h2>
            </div>
            <span className="panel-note">
              {readyCount} ready
            </span>
          </div>

          <div className="group-stack">
            {overlayGroups.map((group) => (
              <section key={group.title} className="overlay-group">
                <div className="overlay-group__header">
                  <div>
                    <h3>{group.title}</h3>
                    <p>{group.note}</p>
                  </div>
                  <span className="group-count">{group.overlays.length}</span>
                </div>

                <div className="overlay-grid">
                  {group.overlays.map((overlay) => (
                    <article key={overlay.route} className="overlay-card">
                      <div className="overlay-card__header">
                        <div className="overlay-card__title">
                          <h4>{overlay.name}</h4>
                          <span className={`badge badge-${overlay.status.toLowerCase()}`}>
                            {overlay.status}
                          </span>
                        </div>
                        <button
                          className="mini-action"
                          type="button"
                          onClick={() => copyText(overlay.fullUrl)}
                        >
                          {copiedUrl === overlay.fullUrl ? 'Copied' : 'Copy'}
                        </button>
                      </div>

                      <p>{overlay.note}</p>

                      <a
                        className="overlay-link"
                        href={overlay.fullUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <code>{overlay.fullUrl}</code>
                      </a>
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </article>

        <aside className="panel panel--stack">
          <div className="panel-heading">
            <div>
              <p className="panel-kicker">Service Details</p>
              <h2>Runtime</h2>
            </div>
          </div>

          <article className="detail-card">
            <span className="meta-label">Last Event</span>
            <strong>{formatLastEvent(service.lastEventAt)}</strong>
          </article>

          <article className="detail-card">
            <span className="meta-label">Dashboard Base</span>
            <a href={service.baseUrl} target="_blank" rel="noreferrer">
              {service.baseUrl}
            </a>
          </article>

          <article className="detail-card">
            <span className="meta-label">Primary Banner</span>
            <a href={service.warningBannerUrl} target="_blank" rel="noreferrer">
              {service.warningBannerUrl}
            </a>
          </article>

          <article className="detail-card">
            <span className="meta-label">Stream</span>
            <code>{service.streamUrl}</code>
          </article>

          <article className="detail-card">
            <span className="meta-label">Mode</span>
            <strong>{formatMode(service.mode)}</strong>
          </article>

          <article className="detail-card">
            <span className="meta-label">Config File</span>
            <code>{service.configPath}</code>
          </article>
        </aside>
      </section>
    </main>
  )
}

export default App
