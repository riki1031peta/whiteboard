
import type { SavedBoardItem } from '~/types/board'

export function useBoardCollaboration() {
  const { $supabase } = useNuxtApp()

  let channel: ReturnType<typeof $supabase.channel> | null = null
  let token: string | null = null

  async function ensureUser() {
    const { data } = await $supabase.auth.getSession()

    if (data.session?.user) return data.session.user

    const result = await $supabase.auth.signInAnonymously()

    if (result.error) throw result.error
    if (!result.data.user) throw new Error('認証に失敗しました')

    return result.data.user
  }

  async function fetchBoard(shareToken: string) {
    await ensureUser()

    const { data, error } = await $supabase.rpc(
      'collab_get_board',
      { p_token: shareToken }
    )

    if (error) throw error
    if (!data) throw new Error('ボードが見つかりません')

    return data as {
      id: string
      title: string
      items: SavedBoardItem[]
    }
  }

  async function saveItem(item: SavedBoardItem) {
    if (!token) throw new Error('共有ボードに接続されていません')

    const { error } = await $supabase.rpc(
      'collab_save_item',
      {
        p_token: token,
        p_item: item,
      }
    )

    if (error) throw error

    await notifyChange()
  }

  async function deleteItem(itemId: string) {
    if (!token) throw new Error('共有ボードに接続されていません')

    const { error } = await $supabase.rpc(
      'collab_delete_item',
      {
        p_token: token,
        p_item_id: itemId,
      }
    )

    if (error) throw error

    await notifyChange()
  }

  async function notifyChange() {
    if (!channel) return

    await channel.send({
      type: 'broadcast',
      event: 'board-changed',
      payload: {},
    })
  }

  async function connect(
    shareToken: string,
    onRemoteChange: () => void
  ) {
    await ensureUser()

    if (channel) {
      await $supabase.removeChannel(channel)
    }

    token = shareToken

    channel = $supabase
      .channel(`board:${shareToken}`, {
        config: {
          broadcast: { self: false },
        },
      })
      .on('broadcast', {
        event: 'board-changed',
      }, () => {
        onRemoteChange()
      })
      .subscribe()

    return fetchBoard(shareToken)
  }

  async function disconnect() {
    if (channel) {
      await $supabase.removeChannel(channel)
      channel = null
    }

    token = null
  }

  return {
    connect,
    disconnect,
    fetchBoard,
    saveItem,
    deleteItem,
  }
}
