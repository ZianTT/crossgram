import { useEffect, useMemo, useRef, useState } from 'react'
import type { CapturedMtprotoEvent, MtprotoDebugData } from '../src/types.js'
import { getRpcResultMetrics, groupRpcEvents } from '../src/event-groups.js'
import { useRpc, type PageProps } from 'cordis-webui-react/client'
import { Icon } from 'cordis-webui-react/icons'
import {
  ActionError,
  ConfirmAction,
  LiveContent,
  useAction,
} from 'cordis-webui-react/components'
import { useCapturePages, type CaptureFilters } from './capture.js'
import { copyText, formatMs, sameOriginPath } from 'cordis-webui-react/utils'
export default function CapturePage(props: PageProps) {
  const rpc = useRpc<MtprotoDebugData>(props.entryId)
  const action = useAction()
  const [filters, setFilters] = useState<CaptureFilters>({})
  const [expanded, setExpanded] = useState<number | undefined>(undefined)
  const list = useRef<HTMLDivElement>(null)
  const capture = useCapturePages(
    rpc.data.apiPath,
    filters,
    rpc.ready,
    rpc.data.revision,
  )
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
  const dropped = capture.snapshot?.dropped ?? 0
  const retained = capture.snapshot?.total ?? capture.events.length
  const filtersKey = JSON.stringify(filters)
  useEffect(() => {
    // A new filter starts a new window; keep the list at the newest event.
    list.current?.scrollTo({ top: 0 })
  }, [filtersKey])
  const onScroll = () => {
    const element = list.current
    if (!element || capture.loading || !capture.snapshot?.hasOlder) return
    if (
      element.scrollTop + element.clientHeight >=
      element.scrollHeight - 240
    )
      void capture.load('older')
  }
  useEffect(() => {
    // A filtered result can be shorter than the viewport; fill it so the scroll
    // handler has a chance to continue paging.
    const element = list.current
    if (!element || capture.loading || !capture.snapshot?.hasOlder) return
    if (element.scrollHeight <= element.clientHeight + 1)
      void capture.load('older')
  }, [capture.events.length, capture.loading, capture.snapshot?.hasOlder])
  return (
    <>
      <ActionError error={action.error || capture.error} />
      <LiveContent ready={rpc.ready}>
        <div className="workbench capture-workbench">
          <header className="workbench-header">
            <h1>MTProto capture</h1>
            <span className="workbench-sub">
              {rpc.data.capturing ? 'Capturing' : 'Paused'}
              {capture.loading ? ' · loading events…' : ''}
            </span>
            <div className="workbench-actions">
              <button
                className="button tonal"
                aria-pressed={capture.live}
                onClick={() => capture.setLive(!capture.live)}
              >
                {capture.live ? 'Pause live' : 'Follow live'}
              </button>
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
            </div>
          </header>
          <div className="workbench-toolbar">
            <label className="field grow">
              <span className="sr-only">Search captured events</span>
              <input
                type="search"
                value={filters.grep ?? ''}
                placeholder="Filter by method, payload text, connection…"
                onChange={(event) =>
                  setFilter('grep', event.currentTarget.value)
                }
              />
            </label>
            <select
              aria-label="Direction"
              value={filters.direction ?? ''}
              onChange={(event) =>
                setFilter('direction', event.currentTarget.value)
              }
            >
              <option value="">All directions</option>
              <option value="client->server">Client → server</option>
              <option value="server->client">Server → client</option>
            </select>
            <select
              aria-label="Phase"
              value={filters.phase ?? ''}
              onChange={(event) => setFilter('phase', event.currentTarget.value)}
            >
              <option value="">All phases</option>
              <option>handshake</option>
              <option>message</option>
              <option>connection</option>
            </select>
            {filters.typeName || filters.excludeName ? (
              <button
                className="chip"
                title="Clear the method type filter"
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
                ×
              </button>
            ) : null}
            {filters.connectionId || filters.since || filters.field ? (
              <button
                className="button outlined"
                onClick={() =>
                  setFilters((value) => ({
                    ...value,
                    connectionId: '',
                    since: '',
                    field: '',
                  }))
                }
              >
                Clear filters
              </button>
            ) : null}
          </div>
          <div className="workbench-body capture-body">
            <div
              ref={list}
              className="workbench-scroll capture-list"
              role="list"
              aria-label="Captured MTProto events"
              tabIndex={0}
              onScroll={onScroll}
            >
              <table className="workbench-table capture-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Method</th>
                    <th aria-label="Direction" />
                    <th className="capture-col-conn">Connection</th>
                    <th className="capture-col-phase">Phase</th>
                    <th className="cell-right">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {ids.map((id) => {
                    const group = groups.get(id)!
                    const event = capture.details.get(id) ?? group.event
                    const result = group.result
                      ? (capture.details.get(group.result.id) ?? group.result)
                      : undefined
                    const metrics = getRpcResultMetrics(event, result)
                    return (
                      <tr
                        key={id}
                        className={
                          'capture-row' +
                          (metrics?.state === 'error' ? ' rpc-error' : '')
                        }
                        aria-selected={expanded === id}
                        onClick={(click) => {
                          if ((click.target as HTMLElement).closest('button'))
                            return
                          toggle(id)
                        }}
                      >
                        <td className="capture-time">
                          <time
                            dateTime={new Date(event.timestamp).toISOString()}
                          >
                            {clock(event.timestamp)}
                          </time>
                        </td>
                        <td className="cell-grow capture-name">
                          <button
                            className="capture-row-header"
                            aria-expanded={expanded === id}
                            onClick={() => toggle(id)}
                          >
                            <span className="capture-row-title">
                              <strong>{event.name}</strong>
                            </span>
                          </button>
                        </td>
                        <td>
                          <span
                            className="capture-direction"
                            aria-hidden="true"
                            title={
                              event.direction === 'client->server'
                                ? 'Client → server'
                                : 'Server → client'
                            }
                          >
                            <Icon
                              name={
                                event.direction === 'client->server'
                                  ? 'arrowUpRight'
                                  : 'arrowDownLeft'
                              }
                              size={12}
                            />
                          </span>
                        </td>
                        <td className="capture-col-conn">
                          {event.connectionId}
                        </td>
                        <td className="capture-col-phase">{event.phase}</td>
                        <td className="cell-right capture-duration">
                          {metrics ? (
                            <span
                              className={
                                metrics.state === 'error' ? 'capture-error' : ''
                              }
                            >
                              {formatMs(metrics.durationMs)}
                            </span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {!ids.length && !capture.loading ? (
                <div className="capture-empty">
                  <h3>No matching events</h3>
                  <p className="muted">
                    Start capture or adjust the filters. Payloads are fetched
                    only when you open an event.
                  </p>
                </div>
              ) : null}
              {capture.loading && ids.length ? (
                <p className="capture-more muted" role="status">
                  Loading older events…
                </p>
              ) : null}
              {!capture.snapshot?.hasOlder && ids.length ? (
                <p className="capture-more muted">End of retained capture.</p>
              ) : null}
            </div>
            {expanded !== undefined && groups.get(expanded) ? (
              <section
                className="capture-inspector"
                aria-label="Captured event details"
              >
                <header className="capture-inspector-header">
                  <strong>{groups.get(expanded)!.event.name}</strong>
                  <span className="muted">
                    #{expanded} · {groups.get(expanded)!.event.connectionId} ·{' '}
                    {clock(groups.get(expanded)!.event.timestamp)}
                  </span>
                  <button
                    className="icon-button"
                    aria-label="Close details"
                    onClick={() => {
                      setExpanded(undefined)
                      capture.keepDetails([])
                    }}
                  >
                    <Icon name="x" size={14} />
                  </button>
                </header>
                <div className="capture-inspector-body">
                  <EventDetail
                    event={
                      capture.details.get(expanded) ??
                      groups.get(expanded)!.event
                    }
                    filter={filterType}
                    rawLink={rawLink}
                  />
                  {groups.get(expanded)!.result ? (
                    <EventDetail
                      event={
                        capture.details.get(
                          groups.get(expanded)!.result!.id,
                        ) ?? groups.get(expanded)!.result!
                      }
                      filter={filterType}
                      rawLink={rawLink}
                    />
                  ) : null}
                </div>
              </section>
            ) : null}
          </div>
        </div>
      </LiveContent>
    </>
  )
}
function clock(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number, length = 2) =>
    String(value).padStart(length, '0')
  return (
    pad(date.getHours()) +
    ':' +
    pad(date.getMinutes()) +
    ':' +
    pad(date.getSeconds()) +
    '.' +
    pad(date.getMilliseconds(), 3)
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
        <span className="chip">{props.event.phase}</span>
        <span className="chip">
          {props.event.direction === 'client->server' ? '↑' : '↓'}
        </span>
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
