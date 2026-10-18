import Page0 from './page.js'
import type { ClientModule } from 'cordis-webui-solidjs/client'
export default { pages: [
  { path: "/history-backfill", title: "History backfill", icon: "↺", group: "Observe", component: Page0 },
] } satisfies ClientModule
