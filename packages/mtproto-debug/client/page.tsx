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
  const [pane, setPane] = useState<'event' | 'result'>('event')
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
  const select = (id: number | undefined) => {
    setPane('event')
    if (id === undefined) {
      setExpanded(undefined)
      capture.keepDetails([])
      return
    }
    const group = groups.get(id)
    if (!group) return
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
  const selected = expanded === undefined ? undefined : groups.get(expanded)
  const result = selected?.result
  const detail =
    pane === 'result' && result
      ? (capture.details.get(result.id) ?? result)
      : selected
        ? (capture.details.get(selected.event.id) ?? selected.event)
        : undefined
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
                  select(undefined)
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
                    const groupResult = group.result
                      ? (capture.details.get(group.result.id) ?? group.result)
                      : undefined
                    const metrics = getRpcResultMetrics(event, groupResult)
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
                          select(expanded === id ? undefined : id)
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
                            onClick={() =>
                              select(expanded === id ? undefined : id)
                            }
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
            {selected && detail ? (
              <section
                className="capture-inspector"
                aria-label="Captured event details"
              >
                <header className="capture-inspector-header">
                  <strong>{detail.name}</strong>
                  <span className="muted">
                    #{detail.id} · {detail.connectionId} ·{' '}
                    {clock(detail.timestamp)}
                  </span>
                  {selected.result ? (
                    <div
                      className="segmented capture-panes"
                      role="tablist"
                      aria-label="Captured event sections"
                    >
                      <button
                        role="tab"
                        aria-selected={pane === 'event'}
                        className={pane === 'event' ? 'selected' : undefined}
                        onClick={() => setPane('event')}
                      >
                        Event
                      </button>
                      <button
                        role="tab"
                        aria-selected={pane === 'result'}
                        className={pane === 'result' ? 'selected' : undefined}
                        onClick={() => {
                          setPane('result')
                          if (selected.result)
                            void capture.loadDetails(selected.result)
                        }}
                      >
                        Result
                      </button>
                    </div>
                  ) : null}
                  <button
                    className="icon-button"
                    aria-label="Close details"
                    onClick={() => select(undefined)}
                  >
                    <Icon name="x" size={14} />
                  </button>
                </header>
                <div className="capture-inspector-body">
                  <EventDetail
                    event={detail}
                    filter={filterType}
                    rawLink={rawLink}
                  />
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
    <section className="event-detail">
      <div className="event-detail-toolbar">
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
        <span className="chip">{props.event.phase}</span>
        <span className="chip">
          {props.event.direction === 'client->server' ? '↑ request' : '↓ response'}
        </span>
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
        <p className="muted event-detail-loading" role="status">
          <Icon name="refresh" size={15} /> Loading payload…
        </p>
      ) : (
        <JsonTree value={props.event.payload} />
      )}
    </section>
  )
}
type JsonKind =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  | 'other'
function kindOf(value: unknown): JsonKind {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  switch (typeof value) {
    case 'object':
      return 'object'
    case 'string':
      return 'string'
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    default:
      return 'other'
  }
}
function previewOf(value: unknown): string {
  const kind = kindOf(value)
  if (kind === 'array') return 'Array(' + (value as unknown[]).length + ')'
  if (kind === 'object') return '{…}'
  if (kind === 'string') {
    const text = value as string
    return text.length > 200
      ? JSON.stringify(text.slice(0, 200) + '…')
      : JSON.stringify(text)
  }
  if (kind === 'null') return 'null'
  if (kind === 'other') return String(value)
  return String(value)
}
function primitiveClass(kind: JsonKind): string {
  return 'json-value json-' + kind
}
function JsonNode(props: {
  name?: string
  value: unknown
  depth: number
  defaultExpanded?: boolean
}) {
  const [expanded, setExpanded] = useState(props.defaultExpanded ?? false)
  const [showFull, setShowFull] = useState(false)
  const [limit, setLimit] = useState(100)
  const kind = kindOf(props.value)
  const expandable = kind === 'object' || kind === 'array'
  const entries = useMemo(() => {
    if (kind === 'array')
      return (props.value as unknown[]).map(
        (item, index) => [String(index), item] as const,
      )
    if (kind === 'object')
      return Object.entries(props.value as Record<string, unknown>)
    return []
  }, [kind, props.value])
  const indent = { paddingLeft: 12 + props.depth * 14 }
  if (!expandable) {
    const text = props.value as string
    const longText = kind === 'string' && text.length > 200
    const shown =
      longText && !showFull
        ? JSON.stringify(text.slice(0, 200) + '…')
        : kind === 'string'
          ? JSON.stringify(
              text.length > 2000 ? text.slice(0, 2000) + '…' : text,
            )
          : previewOf(props.value)
    return (
      <div className="json-row" style={indent}>
        <span className="json-caret" />
        {props.name !== undefined ? (
          <>
            <span className="json-key">{props.name}</span>
            <span className="json-punct">:&nbsp;</span>
          </>
        ) : null}
        <span className={primitiveClass(kind)}>{shown}</span>
        {longText ? (
          <button
            className="json-string-toggle"
            onClick={(event) => {
              event.stopPropagation()
              setShowFull(!showFull)
            }}
          >
            {showFull ? 'collapse' : 'show all'}
          </button>
        ) : null}
      </div>
    )
  }
  return (
    <>
      <div
        className={'json-row json-toggle' + (expandable ? ' expandable' : '')}
        style={indent}
        role="treeitem"
        aria-expanded={expanded}
        tabIndex={0}
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setExpanded(!expanded)
          }
        }}
      >
        <span className="json-caret">{expanded ? '▾' : '▸'}</span>
        {props.name !== undefined ? (
          <>
            <span className="json-key">{props.name}</span>
            <span className="json-punct">:&nbsp;</span>
          </>
        ) : null}
        <span className="json-punct">
          {expanded ? (kind === 'array' ? '[' : '{') : previewOf(props.value)}
        </span>
      </div>
      {expanded ? (
        <>
          {entries.slice(0, limit).map(([key, value]) => (
            <JsonNode key={key} name={key} value={value} depth={props.depth + 1} />
          ))}
          {entries.length > limit ? (
            <div className="json-row" style={indent}>
              <span className="json-caret" />
              <button
                className="json-string-toggle json-more"
                onClick={(event) => {
                  event.stopPropagation()
                  setLimit(limit + 100)
                }}
              >
                Show 100 more ({entries.length - limit} remaining)
              </button>
            </div>
          ) : null}
          <div className="json-row" style={indent}>
            <span className="json-caret" />
            <span className="json-punct">
              {kind === 'array' ? ']' : '}'}
            </span>
          </div>
        </>
      ) : null}
    </>
  )
}
export function JsonTree({ value }: { value: unknown }) {
  return (
    <div className="json-tree" role="tree" aria-label="Payload">
      <JsonNode value={value} depth={0} defaultExpanded />
    </div>
  )
}
