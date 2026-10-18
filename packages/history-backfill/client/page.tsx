import { useState } from 'react'
import { useRpc, type PageProps } from 'cordis-webui-react/client'
import {
  ActionError,
  EmptyState,
  formatNumber,
  LiveContent,
  PageHeader,
  useAction,
} from 'cordis-webui-react/components'
import type {
  BackfillConversationSnapshot,
  BackfillSessionSnapshot,
  BackfillSnapshot,
  HistoryBackfillData,
} from '../src/types.js'
import {
  conversationProgress,
  formatAge,
  formatDate,
  sessionStatusLabel,
} from './model.js'

export default function HistoryBackfillPage(props: PageProps) {
  const rpc = useRpc<HistoryBackfillData>(props.entryId)
  const toggle = useAction()
  const snapshot = rpc.data.snapshot
  return (
    <>
      <PageHeader
        icon="clock"
        title="History backfill"
        description="While an account is idle, slowly read back older and missing group history into the local store."
        actions={
          snapshot ? (
            <button
              className={`button ${snapshot.enabled ? 'outlined' : 'filled'}`}
              disabled={toggle.busy}
              onClick={() =>
                void toggle.run(() => rpc.data.setEnabled(!snapshot.enabled))
              }
            >
              {snapshot.enabled ? 'Pause backfill' : 'Start backfill'}
            </button>
          ) : null
        }
      />
      <ActionError error={toggle.error} />
      <LiveContent ready={rpc.ready}>
        {snapshot ? (
          <BackfillDashboard snapshot={snapshot} data={rpc.data} />
        ) : null}
      </LiveContent>
    </>
  )
}

export function BackfillDashboard(props: {
  snapshot: BackfillSnapshot
  data: HistoryBackfillData
}) {
  const settings = props.snapshot.settings
  return (
    <div className="stack history-backfill">
      <p className="muted">
        {props.snapshot.enabled ? 'Running' : 'Paused'}
        {' · '}idle after {Math.round(settings.idleAfterMs / 1000)}s{' · '}one
        request every ≥{(settings.intervalMs / 1000).toFixed(1)}s{' · '}
        {settings.pageSize} messages per request
        {' · '}
        {settings.maxAgeDays
          ? `up to ${settings.maxAgeDays} days back`
          : 'no age limit'}
        {' · '}progress is kept in memory and rebuilt from stored messages after
        a restart
      </p>
      {props.snapshot.sessions.length ? (
        props.snapshot.sessions.map((session) => (
          <SessionPanel
            key={session.platformSessionId}
            session={session}
            data={props.data}
          />
        ))
      ) : (
        <EmptyState
          icon="clock"
          title="No active accounts"
          description="Backfill starts once a platform account is online."
        />
      )}
      {props.snapshot.recent.length ? (
        <section className="panel">
          <h3>Recent requests</h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Conversation</th>
                  <th>Kind</th>
                  <th>Range</th>
                  <th>Fetched</th>
                  <th>New</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {props.snapshot.recent.map((event, index) => (
                  <tr key={index}>
                    <td>{formatDate(event.at)}</td>
                    <td>{event.title}</td>
                    <td>
                      {event.kind === 'gap' ? 'gap' : 'older'} · {event.mode}
                    </td>
                    <td>{event.range}</td>
                    <td>{formatNumber(event.fetched)}</td>
                    <td>{formatNumber(event.inserted)}</td>
                    <td>{event.error ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  )
}

function SessionPanel(props: {
  session: BackfillSessionSnapshot
  data: HistoryBackfillData
}) {
  const [filter, setFilter] = useState<'pending' | 'all'>('pending')
  const reset = useAction()
  const rows = props.session.conversations.filter(
    (item) => filter === 'all' || !(item.floorReached && item.gapCount === 0),
  )
  return (
    <section className="panel">
      <header>
        <h3>
          {props.session.platformId} · {props.session.platformSessionId}
        </h3>
        <span className="muted">
          {sessionStatusLabel(props.session.status)}
        </span>
      </header>
      <div className="metric-grid compact-metrics">
        <div className="metric">
          <span>Conversations</span>
          <strong>{formatNumber(props.session.totals.conversations)}</strong>
          <p>{formatNumber(props.session.totals.complete)} fully backfilled</p>
        </div>
        <div className="metric">
          <span>Known gaps</span>
          <strong>{formatNumber(props.session.totals.gaps)}</strong>
          <p>
            {formatNumber(props.session.totals.missing)} sequence numbers
            missing
          </p>
        </div>
        <div className="metric">
          <span>Fetched</span>
          <strong>{formatNumber(props.session.totals.fetched)}</strong>
          <p>
            {formatNumber(props.session.totals.inserted)} new messages stored
          </p>
        </div>
        <div className="metric">
          <span>Requests today</span>
          <strong>{formatNumber(props.session.requestsToday)}</strong>
          <p>
            limit {formatNumber(props.session.dailyRequestCap)} · last client
            activity {formatAge(props.session.lastActivityAt)}
          </p>
        </div>
      </div>
      <div className="toolbar">
        <div
          className="segmented"
          role="tablist"
          aria-label="Conversation filter"
        >
          <button
            role="tab"
            aria-selected={filter === 'pending'}
            className={filter === 'pending' ? 'selected' : ''}
            onClick={() => setFilter('pending')}
          >
            Pending
          </button>
          <button
            role="tab"
            aria-selected={filter === 'all'}
            className={filter === 'all' ? 'selected' : ''}
            onClick={() => setFilter('all')}
          >
            All
          </button>
        </div>
      </div>
      <ActionError error={reset.error} />
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Conversation</th>
              <th>Mode</th>
              <th>Progress</th>
              <th>Gaps</th>
              <th>Oldest</th>
              <th>Fetched</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => (
              <ConversationRow
                key={item.conversationId}
                item={item}
                onReset={() =>
                  void reset.run(() =>
                    props.data.resetConversation(
                      props.session.platformSessionId,
                      item.conversationId,
                    ),
                  )
                }
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function ConversationRow(props: {
  item: BackfillConversationSnapshot
  onReset: () => void
}) {
  const item = props.item
  return (
    <tr>
      <td>{item.title}</td>
      <td>{item.mode === 'sequence' ? 'msgSeq' : 'anchor'}</td>
      <td>{conversationProgress(item)}</td>
      <td>
        {item.gapCount
          ? `${formatNumber(item.gapCount)} (${formatNumber(item.missing)})`
          : '—'}
      </td>
      <td>
        {item.oldestTimestamp ? formatDate(item.oldestTimestamp! * 1000) : '—'}
      </td>
      <td>
        {formatNumber(item.fetched)} / {formatNumber(item.inserted)} new
      </td>
      <td>
        {item.lastError
          ? `retry ${formatAge(item.nextAttemptAt)} · ${item.lastError}`
          : item.floorReached
            ? item.floorReason === 'age'
              ? 'reached age limit'
              : 'reached the beginning'
            : 'pending'}
      </td>
      <td>
        {item.failures || item.floorReached ? (
          <button className="button tonal" onClick={() => props.onReset()}>
            Retry
          </button>
        ) : null}
      </td>
    </tr>
  )
}
