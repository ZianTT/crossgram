import type { Database } from '@cordisjs/plugin-database'

const GROUP_ALIAS_KEY = 'qqGroupAlias'

/** 将旧版被群名片覆盖的 `mtproto_im_user` 名称恢复为 `metadata.qqName` 中的全局 QQ 昵称。 */
export async function migrateLegacyQQGroupAliasUsers(
  database: Database,
  platformId: string,
): Promise<number> {
  const users = await database.get('mtproto_im_user', { platformId })
  let changed = 0
  await database.withTransaction(async (transaction) => {
    for (const user of users) {
      if (!Object.hasOwn(user.metadata, GROUP_ALIAS_KEY)) continue
      const metadata = { ...user.metadata }
      delete metadata[GROUP_ALIAS_KEY]
      const qqName = typeof metadata.qqName === 'string' && metadata.qqName.trim()
        ? metadata.qqName
        : undefined
      await transaction.set('mtproto_im_user', { id: user.id }, {
        ...(qqName ? { firstName: qqName } : {}),
        metadata,
        updatedAt: new Date(),
      })
      changed++
    }
  })
  return changed
}
