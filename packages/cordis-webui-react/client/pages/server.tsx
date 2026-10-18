import { useMemo, useState } from 'react'
import type {
  Data,
  ServerRequest,
  ServerRoute,
} from '../../src/server-monitor.js'
import { navigate, useConnection, useRpc, type PageProps } from '../sdk.js'
import { Icon } from '../icons.js'
import {
  ConfirmAction,
  formatBytes,
  JsonView,
  LiveContent,
  Modal,
  PageHeader,
} from '../components.js'
import { pageSlice } from './admin-model.js'
type Row = ServerRequest | ServerRoute
export default function ServerPage({ entryId, path }: PageProps) {
  const rpc = useRpc<Data>(entryId),
    connection = useConnection()
  const [search, setSearch] = useState(''),
    [page, setPage] = useState(0),
    [selected, setSelected] = useState<Row>()
  const requests = path === '/server/requests'
  const rows = useMemo<Row[]>(
    () =>
      (requests
        ? [...(rpc.data.requests ?? [])].reverse()
        : Object.values(rpc.data.routes ?? {}).sort(
            (a, b) => b.requests - a.requests,
          )
      ).filter((row) =>
        (row.method + ' ' + row.path + ' ' + row.plugin)
          .toLowerCase()
          .includes(search.toLowerCase()),
      ),
    [requests, rpc.data.requests, rpc.data.routes, search],
  )
  return (
    <>
      <PageHeader
        title={requests ? 'Incoming requests' : 'Server routes'}
        description="Understand what enters your workspace and where it goes."
        actions={
          <button
            className="button tonal"
            onClick={() => {
              setPage(0)
              navigate(
                connection.config.uiPath +
                  (requests ? '/server/routes' : '/server/requests'),
              )
            }}
          >
            {requests ? 'View routes' : 'View requests'}
          </button>
        }
      />
      <LiveContent ready={rpc.ready}>
        <div className="metric-grid compact-metrics">
          <article className="panel metric">
            <span className="eyebrow">SERVER</span>
            <strong className="metric-text">
              {rpc.data.listening ? 'Listening' : 'Not listening'}
            </strong>
            <p>
              {rpc.data.host}:{rpc.data.port}
            </p>
          </article>
          <article className="panel metric">
            <span className="eyebrow">ROUTES</span>
            <strong>{Object.keys(rpc.data.routes ?? {}).length}</strong>
            <p>HTTP and WebSocket endpoints</p>
          </article>
          <article className="panel metric">
            <span className="eyebrow">RECENT REQUESTS</span>
            <strong>{rpc.data.requests?.length ?? 0}</strong>
            <p>A bounded, live history</p>
          </article>
        </div>
        <div className="panel stack">
          <div className="toolbar">
            <label className="field grow">
              <span>Filter {requests ? 'requests' : 'routes'}</span>
              <input
                type="search"
                value={search}
                onChange={(event) => {
                  setSearch(event.currentTarget.value)
                  setPage(0)
                }}
              />
            </label>
            <ConfirmAction
              label="Reset counters"
              title="Reset server monitoring?"
              description="Clears recent requests and per-route counters, without changing any routes."
              action={() => rpc.data.clear()}
            />
          </div>
          <div className="table-scroll" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th>Method</th>
                  <th>Path</th>
                  <th>Plugin</th>
                  <th>{requests ? 'Status' : 'Requests'}</th>
                  <th>{requests ? 'Received / sent' : 'Average latency'}</th>
                </tr>
              </thead>
              <tbody>
                {pageSlice(rows, page).map((row) => (
                  <tr key={row.id}>
                    <td>
                      <span className="chip">{row.method}</span>
                    </td>
                    <td>
                      <button
                        className="cell-edit truncate"
                        title={row.path}
                        onClick={() => setSelected(row)}
                      >
                        {row.path}
                      </button>
                    </td>
                    <td>{row.plugin ?? '—'}</td>
                    <td>
                      {'status' in row ? row.status || 'Pending' : row.requests}
                    </td>
                    <td>
                      {'avgLatency' in row
                        ? row.avgLatency.toFixed(1) + ' ms'
                        : formatBytes(row.bytesIn) +
                          ' / ' +
                          formatBytes(row.bytesOut)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!rows.length ? (
            <p className="empty-note">
              <Icon name="search" size={16} />
              No matching records.
            </p>
          ) : null}
          <div className="pagination">
            <button
              className="button outlined"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            >
              Previous page
            </button>
            <span>{rows.length} records</span>
            <button
              className="button outlined"
              disabled={(page + 1) * 50 >= rows.length}
              onClick={() => setPage(page + 1)}
            >
              Next page
            </button>
          </div>
        </div>
        {selected ? (
          <Modal
            title={selected.method + ' ' + selected.path}
            onClose={() => setSelected(undefined)}
          >
            <JsonView value={selected} />
          </Modal>
        ) : null}
      </LiveContent>
    </>
  )
}
