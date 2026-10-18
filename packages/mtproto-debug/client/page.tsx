import { useEffect, useMemo, useState } from 'react'
import type { CapturedMtprotoEvent, MtprotoDebugData } from '../src/types.js'
import { getRpcResultMetrics, groupRpcEvents } from '../src/event-groups.js'
import { useRpc, type PageProps } from 'cordis-webui-react/client'
import { Icon } from 'cordis-webui-react/icons'
import {
  ActionError,
  ConfirmAction,
  LiveContent,
  PageHeader,
  useAction,
} from 'cordis-webui-react/components'
import { useCapturePages, type CaptureFilters } from './capture.js'
import { copyText, formatMs, sameOriginPath } from 'cordis-webui-react/utils'
export default function CapturePage(props: PageProps) {
  const rpc = useRpc<MtprotoDebugData>(props.entryId)
  const action = useAction()
  const [filters, setFilters] = useState<CaptureFilters>({})
  const [expanded, setExpanded] = useState<number | undefined>(undefined)
  const capture = useCapturePages(rpc.data.apiPath, filters, rpc.ready)
  const groups = useMemo(
    () =>
      new Map(
        groupRpcEvents(capture.events).map((group) => [group.event.id, group]),
      ),
    [capture.events],
  )
  const ids = useMemo(() => [...groups.keys()].reverse(), [groups])
  useEffect(() => {
    if (expanded !== undefined && !groups.has(expanded)) {
      setExpanded(undefined)
      capture.keepDetails([])
    }
    // `capture` reads through refs, so only the window identity matters here.
  }, [expanded, groups])
  const setFilter = (key: keyof CaptureFilters, value: string) =>
    setFilters((previous) => ({ ...previous, [key]: value }))
  const filterType = (mode: 'include' | 'exclude', name: string) =>
    setFilters((value) => ({
      ...value,
      typeName: mode === 'include' ? name : '',
      excludeName: mode === 'exclude' ? name : '',
    }))
  const toggle = (id: number) => {
    if (expanded === id) {
      setExpanded(undefined)
      capture.keepDetails([])
      return
    }
    const group = groups.get(id)!
    setExpanded(id)
    capture.keepDetails([id, ...(group.result ? [group.result.id] : [])])
    void capture.loadDetails(group.event)
    if (group.result) void capture.loadDetails(group.result)
  }
  const rawLink = (id: number) => {
    const url = new URL(sameOriginPath(rpc.data.apiPath))
    url.searchParams.set('id', String(id))
    url.searchParams.set('limit', '1')
    return url.href
  }
  return (
    <>
      <PageHeader
        title="MTProto capture"
        description="Follow the conversation between your clients and the relay."
        actions={
          <>
            <button
              className="button filled"
              disabled={action.busy || !rpc.ready}
              onClick={() =>
                void action.run(async () => {
                  await (rpc.data.capturing
                    ? rpc.data.pause()
                    : rpc.data.start())
                  await capture.load('latest')
                })
              }
            >
              {rpc.data.capturing ? 'Pause capture' : 'Start capture'}
            </button>
            <ConfirmAction
              label="Clear capture"
              title="Clear all captured events?"
              description="The in-memory capture buffer will be cleared. This does not disconnect clients."
              action={async () => {
                await rpc.data.clear()
                setExpanded(undefined)
                capture.keepDetails([])
                await capture.load('latest')
              }}
            />
          </>
        }
      />
      <ActionError error={action.error || capture.error} />
      <LiveContent ready={rpc.ready}>
        <section className="panel stack capture-controls">
          <div className="toolbar">
            <label className="field grow">
              <span>Search captured events</span>
              <input
                type="search"
                value={filters.grep ?? ''}
                placeholder="Method, payload text, connection…"
                onChange={(event) =>
                  setFilter('grep', event.currentTarget.value)
                }
              />
            </label>
            <button
              className="button tonal"
              aria-pressed={capture.live}
              onClick={() => capture.setLive(!capture.live)}
            >
              {capture.live ? 'Pause live view' : 'Follow latest'}
            </button>
          </div>
          <details>
            <summary>Advanced filters</summary>
            <div className="capture-filter-grid">
              <label className="field">
                <span>Direction</span>
                <select
                  aria-label="Direction"
                  value={filters.direction ?? ''}
                  onChange={(event) =>
                    setFilter('direction', event.currentTarget.value)
                  }
                >
                  <option value="">Both directions</option>
                  <option value="client->server">Client to server</option>
                  <option value="server->client">Server to client</option>
                </select>
              </label>
              <label className="field">
                <span>Phase</span>
                <select
                  aria-label="Phase"
                  value={filters.phase ?? ''}
                  onChange={(event) =>
                    setFilter('phase', event.currentTarget.value)
                  }
                >
                  <option value="">All phases</option>
                  <option>handshake</option>
                  <option>message</option>
                  <option>connection</option>
                </select>
              </label>
              <label className="field">
                <span>Connection ID</span>
                <input
                  value={filters.connectionId ?? ''}
                  onChange={(event) =>
                    setFilter('connectionId', event.currentTarget.value)
                  }
                />
              </label>
              <label className="field">
                <span>Since</span>
                <input
                  placeholder="5m, 1h, or a timestamp"
                  value={filters.since ?? ''}
                  onChange={(event) =>
                    setFilter('since', event.currentTarget.value)
                  }
                />
              </label>
              <label className="field">
                <span>Exact payload field</span>
                <input
                  placeholder="payload.userId=123"
                  value={filters.field ?? ''}
                  onChange={(event) =>
                    setFilter('field', event.currentTarget.value)
                  }
                />
              </label>
            </div>
          </details>
          {filters.typeName || filters.excludeName ? (
            <button
              className="button outlined type-filter"
              onClick={() =>
                setFilters((value) => ({
                  ...value,
                  typeName: '',
                  excludeName: '',
                }))
              }
            >
              {filters.typeName
                ? 'Only: ' + filters.typeName
                : 'Exclude: ' + filters.excludeName}{' '}
              · clear
            </button>
          ) : null}
          <div className="toolbar">
            <span className="chip">
              {rpc.data.capturing ? 'Capturing' : 'Capture paused'}
            </span>
            <span className="muted">
              {capture.events.length} shown / {capture.snapshot?.total ?? 0}{' '}
              retained · {capture.snapshot?.dropped ?? 0} dropped
            </span>
            {capture.loading ? (
              <span className="muted" role="status">
                Updating…
              </span>
            ) : null}
          </div>
        </section>
        <section className="capture-list" aria-label="Captured MTProto events">
          {ids.map((id) => {
            const group = groups.get(id)!
            const event = capture.details.get(id) ?? group.event
            const result = group.result
              ? (capture.details.get(group.result.id) ?? group.result)
              : undefined
            return (
              <CaptureRow
                key={id}
                event={event}
                result={result}
                expanded={expanded === id}
                toggle={() => toggle(id)}
                filter={filterType}
                rawLink={rawLink}
              />
            )
          })}
          {!ids.length && !capture.loading ? (
            <div className="panel empty-state">
              <h2>No matching events</h2>
              <p>
                Start capture or adjust your filters. Payloads are fetched only
                when you expand an event.
              </p>
            </div>
          ) : null}
        </section>
        <div className="panel pagination capture-pagination">
          <button
            className="button outlined"
            disabled={
              !rpc.ready || capture.loading || !capture.snapshot?.hasOlder
            }
            aria-label="Load older events"
            onClick={() => void capture.load('older')}
          >
            Older
          </button>
          <button
            className="button tonal"
            disabled={!rpc.ready || capture.loading}
            aria-label="Show latest events"
            onClick={() => void capture.load('latest')}
          >
            Latest
          </button>
          <button
            className="button outlined"
            disabled={
              !rpc.ready || capture.loading || !capture.snapshot?.hasNewer
            }
            aria-label="Load newer events"
            onClick={() => void capture.load('newer')}
          >
            Newer
          </button>
        </div>
      </LiveContent>
    </>
  )
}
function CaptureRow(props: {
  event: CapturedMtprotoEvent
  result?: CapturedMtprotoEvent
  expanded: boolean
  toggle: () => void
  filter: (mode: 'include' | 'exclude', name: string) => void
  rawLink: (id: number) => string
}) {
  const metrics = getRpcResultMetrics(props.event, props.result)
  return (
    <article
      className={
        'capture-row' +
        (metrics?.state === 'error' ? ' rpc-error' : '') +
        (props.expanded ? ' expanded' : '')
      }
    >
      <button
        className="capture-row-header"
        aria-expanded={props.expanded}
        onClick={props.toggle}
      >
        <span className="capture-direction" aria-hidden="true">
          <Icon
            name={
              props.event.direction === 'client->server'
                ? 'arrowUpRight'
                : 'arrowDownLeft'
            }
            size={16}
          />
        </span>
        <div className="capture-row-title">
          <strong>{props.event.name}</strong>
          <small>
            {props.event.connectionId} ·{' '}
            {props.event.direction === 'client->server'
              ? 'Client → server'
              : 'Server → client'}{' '}
            · {props.event.phase}
          </small>
        </div>
        <div className="capture-row-meta">
          <time dateTime={new Date(props.event.timestamp).toISOString()}>
            {new Date(props.event.timestamp).toLocaleTimeString()}
          </time>
          {metrics ? (
            <span
              className={'chip ' + (metrics.state === 'error' ? 'error' : '')}
            >
              {formatMs(metrics.durationMs)} · {metrics.state}
            </span>
          ) : null}
        </div>
        <Icon name={props.expanded ? 'minus' : 'plus'} size={16} />
      </button>
      {props.result ? (
        <p className="capture-result">
          Result: <code>{props.result.name}</code>
        </p>
      ) : null}
      {props.expanded ? (
        <div className="capture-detail">
          <EventDetail
            event={props.event}
            filter={props.filter}
            rawLink={props.rawLink}
          />
          {props.result ? (
            <EventDetail
              event={props.result}
              filter={props.filter}
              rawLink={props.rawLink}
            />
          ) : null}
        </div>
      ) : null}
    </article>
  )
}
function EventDetail(props: {
  event: CapturedMtprotoEvent
  filter: (mode: 'include' | 'exclude', name: string) => void
  rawLink: (id: number) => string
}) {
  const action = useAction()
  return (
    <section className="stack event-detail">
      <div className="toolbar">
        <strong className="grow">{props.event.name}</strong>
        <button
          className="button outlined"
          onClick={() => props.filter('include', props.event.name)}
        >
          Only this type
        </button>
        <button
          className="button outlined"
          onClick={() => props.filter('exclude', props.event.name)}
        >
          Exclude this type
        </button>
        <a
          className="button outlined"
          href={props.rawLink(props.event.id)}
          target="_blank"
          rel="noopener noreferrer"
        >
          Raw event
        </a>
        <button
          className="button tonal"
          disabled={props.event.payloadOmitted}
          onClick={() =>
            void action.run(() =>
              copyText(JSON.stringify(props.event.payload, null, 2)),
            )
          }
        >
          Copy payload
        </button>
      </div>
      <dl className="event-metadata">
        {Object.entries({
          'Event ID': props.event.id,
          'Message ID': props.event.messageId,
          'Request ID': props.event.requestMessageId,
          Sequence: props.event.seqNo,
          'Auth key': props.event.authKeyId,
          Session: props.event.sessionId,
        }).map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>
              <code>{value ?? '—'}</code>
            </dd>
          </div>
        ))}
      </dl>
      <ActionError error={action.error || props.event.error || ''} />
      {props.event.payloadOmitted ? (
        <p className="muted" role="status">
          <Icon name="refresh" size={15} /> Loading payload…
        </p>
      ) : (
        <div className="json-tree">
          <JsonTree value={props.event.payload} />
        </div>
      )}
    </section>
  )
}
export function JsonTree(props: {
  value: unknown
  name?: string
  depth?: number
}) {
  const [expanded, setExpanded] = useState(() => !props.depth)
  const [limit, setLimit] = useState(30)
  const [stringLimit, setStringLimit] = useState(800)
  const value = props.value
  const object = value !== null && typeof value === 'object'
  const keys = useMemo(
    () =>
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? Object.keys(value)
        : [],
    [value],
  )
  const count = Array.isArray(value) ? value.length : keys.length
  const entries = useMemo(() => {
    if (value === null || typeof value !== 'object') return []
    if (Array.isArray(value))
      return value.slice(0, limit).map((item, index) => ({
        key: String(index),
        value: item as unknown,
      }))
    return keys.slice(0, limit).map((key) => ({
      key,
      value: (value as Record<string, unknown>)[key],
    }))
  }, [keys, limit, value])
  const rawText = String(value)
  const text =
    typeof value === 'string'
      ? JSON.stringify(rawText.slice(0, stringLimit))
      : rawText.slice(0, stringLimit)
  if (!object)
    return (
      <div className="json-leaf">
        {props.name ? <strong>{props.name}: </strong> : null}
        <span>{text}</span>
        {rawText.length > stringLimit ? (
          stringLimit < 16000 ? (
            <button
              className="field-reset"
              onClick={() =>
                setStringLimit(Math.min(16000, stringLimit + 2000))
              }
            >
              Show more ({rawText.length} characters total)
            </button>
          ) : (
            <span className="muted">
              {' '}
              Preview limited to 16,000 characters; use the raw event link for
              the full value.
            </span>
          )
        ) : null}
      </div>
    )
  return (
    <div className="json-branch">
      <button
        className="json-toggle"
        aria-expanded={expanded}
        disabled={(props.depth ?? 0) > 20}
        onClick={() => setExpanded(!expanded)}
      >
        <Icon name={expanded ? 'minus' : 'plus'} size={14} />
        <strong>{props.name ?? 'Payload'}</strong>
        <span className="muted">
          {count} {Array.isArray(value) ? 'items' : 'keys'}
        </span>
      </button>
      {expanded && (props.depth ?? 0) <= 20 ? (
        <div className="json-children">
          {entries.map((entry) => (
            <JsonTree
              key={entry.key}
              name={entry.key}
              value={entry.value}
              depth={(props.depth ?? 0) + 1}
            />
          ))}
          {count > limit ? (
            <button
              className="button outlined"
              onClick={() => setLimit(limit + 30)}
            >
              Show 30 more ({count - limit} remaining)
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
