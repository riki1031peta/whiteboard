
<script setup lang="ts">
type Board = {
  id: string
  title: string | null
  updated_at: string | null
  share_token: string | null
}

const { $supabase } = useNuxtApp()
const router = useRouter()

const boards = ref<Board[]>([])
const loading = ref(true)
const creating = ref(false)
const errorMessage = ref('')
const processingId = ref<string | null>(null)

async function ensureUser() {
  const { data, error } = await $supabase.auth.getSession()

  if (error) throw error

  if (data.session?.user) {
    return data.session.user
  }

  const result = await $supabase.auth.signInAnonymously()

  if (result.error || !result.data.user) {
    throw result.error ?? new Error('匿名認証に失敗しました')
  }

  return result.data.user
}

async function fetchBoards() {
  loading.value = true
  errorMessage.value = ''

  try {
    const user = await ensureUser()

    const { data, error } = await $supabase
      .from('boards')
      .select('id, title, updated_at, share_token')
      .eq('owner_id', user.id)
      .order('updated_at', { ascending: false })

    if (error) throw error

    boards.value = (data ?? []) as Board[]
  } catch (error) {
    console.error('ボード一覧取得エラー:', error)
    errorMessage.value = 'ボード一覧の取得に失敗しました'
  } finally {
    loading.value = false
  }
}

async function createBoard() {
  if (creating.value) return

  creating.value = true
  errorMessage.value = ''

  try {
    const user = await ensureUser()

    const { data, error } = await $supabase
      .from('boards')
      .insert({
        owner_id: user.id,
        title: '無題のボード',
        content: [],
      })
      .select('id')
      .single()

    if (error) throw error

    localStorage.setItem('whiteboard-id', data.id)

    await router.push(`/board/${data.id}`)
  } catch (error) {
    console.error('ボード作成エラー:', error)
    errorMessage.value = '新しいボードの作成に失敗しました'
  } finally {
    creating.value = false
  }
}

function openBoard(id: string) {
  localStorage.setItem('whiteboard-id', id)
  router.push(`/board/${id}`)
}

async function renameBoard(board: Board) {
  const title = window.prompt(
    '新しいボード名を入力してください',
    board.title || '無題のボード'
  )

  if (title === null) return

  const trimmedTitle = title.trim()

  if (!trimmedTitle) {
    alert('ボード名を入力してください')
    return
  }

  if (trimmedTitle.length > 255) {
    alert('ボード名は255文字以内にしてください')
    return
  }

  processingId.value = board.id
  errorMessage.value = ''

  try {
    const user = await ensureUser()

    const { error } = await $supabase
      .from('boards')
      .update({
        title: trimmedTitle,
        updated_at: new Date().toISOString(),
      })
      .eq('id', board.id)
      .eq('owner_id', user.id)

    if (error) throw error

    await fetchBoards()
  } catch (error) {
    console.error('ボード名変更エラー:', error)
    errorMessage.value = 'ボード名の変更に失敗しました'
  } finally {
    processingId.value = null
  }
}

async function deleteBoard(board: Board) {
  const confirmed = window.confirm(
    `「${board.title || '無題のボード'}」を削除しますか？\nこの操作は取り消せません。`
  )

  if (!confirmed) return

  processingId.value = board.id
  errorMessage.value = ''

  try {
    const user = await ensureUser()

    const { error } = await $supabase
      .from('boards')
      .delete()
      .eq('id', board.id)
      .eq('owner_id', user.id)

    if (error) throw error

    if (localStorage.getItem('whiteboard-id') === board.id) {
      localStorage.removeItem('whiteboard-id')
    }

    await fetchBoards()
  } catch (error) {
    console.error('ボード削除エラー:', error)
    errorMessage.value = 'ボードの削除に失敗しました'
  } finally {
    processingId.value = null
  }
}

function formatDate(value: string | null) {
  if (!value) return '更新日時なし'

  return new Date(value).toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

onMounted(() => {
  void fetchBoards()
})
</script>

<template>
  <main class="dashboard">
    <div class="container">
      <header class="header">
        <div>
          <p class="eyebrow">MY WORKSPACE</p>
          <h1>My Whiteboards</h1>
          <p class="description">
            アイデアを自由に描いて、みんなと共有しよう。
          </p>
        </div>

        <button
          class="create-button"
          :disabled="creating || loading"
          @click="createBoard"
        >
          {{ creating ? '作成中...' : '＋ 新しいボード' }}
        </button>
      </header>

      <div v-if="errorMessage" class="error-message">
        {{ errorMessage }}
      </div>

      <section class="board-section">
        <div class="section-header">
          <h2>保存したボード</h2>
          <span class="board-count">
            {{ boards.length }} 件
          </span>
        </div>

        <div v-if="loading" class="state">
          ボードを読み込み中...
        </div>

        <div v-else-if="boards.length === 0" class="empty-state">
          <div class="empty-icon">✏️</div>
          <h3>まだボードがありません</h3>
          <p>新しいボードを作成して、自由に描いてみましょう！</p>

          <button
            class="create-button"
            :disabled="creating"
            @click="createBoard"
          >
            ＋ 最初のボードを作成
          </button>
        </div>

        <div v-else class="board-grid">
          <article
            v-for="board in boards"
            :key="board.id"
            class="board-card"
          >
            <button
              class="board-preview"
              @click="openBoard(board.id)"
            >
              <span class="preview-icon">✏️</span>
              <span class="preview-text">OPEN BOARD →</span>
            </button>

            <div class="card-content">
              <button
                class="board-title"
                @click="openBoard(board.id)"
              >
                {{ board.title || '無題のボード' }}
              </button>

              <p class="updated-at">
                更新：{{ formatDate(board.updated_at) }}
              </p>

              <span
                v-if="board.share_token"
                class="shared-label"
              >
                共同編集中
              </span>

              <div class="card-actions">
                <button
                  class="edit-button"
                  :disabled="processingId === board.id"
                  @click="renameBoard(board)"
                >
                  名前変更
                </button>

                <button
                  class="delete-button"
                  :disabled="processingId === board.id"
                  @click="deleteBoard(board)"
                >
                  削除
                </button>
              </div>
            </div>
          </article>
        </div>
      </section>
    </div>
  </main>
</template>

<style scoped>
@import url('https://fonts.googleapis.com/css2?family=DotGothic16&display=swap');

* {
  box-sizing: border-box;
}

.dashboard {
  min-height: 100dvh;
  background-color: #dff0d5;
  background-image: radial-gradient(#80ad68 1.25px, transparent 1.25px);
  background-size: 16px 16px;
  color: #183d2c;
  padding: 48px 24px;
}

.container {
  max-width: 1040px;
  margin: 0 auto;
  padding: 30px;
  border: 3px double #285a3b;
  background: #fffdf1;
  box-shadow: 8px 8px 0 #285a3b;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  margin: -30px -30px 36px;
  padding: 22px 30px 24px;
  border-bottom: 3px dotted #56844b;
  background: #f5f3d7;
}

.eyebrow {
  display: inline-block;
  color: #a52e43;
  font-family: 'Courier New', monospace;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0;
  margin: 0 0 10px;
  padding: 4px 7px;
  border: 1px solid #a52e43;
  background: #fffdf1;
}

h1 {
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 36px;
  font-weight: 700;
  margin: 0 0 8px;
}

.description {
  color: #47684c;
  font-size: 14px;
  line-height: 1.7;
  margin: 0;
}

.create-button {
  flex-shrink: 0;
  border: 2px solid #183d2c;
  border-radius: 2px;
  background: #d8464c;
  color: #fffdf1;
  padding: 12px 18px;
  font-family: 'Courier New', monospace;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  box-shadow: 3px 3px 0 #183d2c;
  transition: transform 0.12s, box-shadow 0.12s;
}

.create-button:hover {
  background: #bf303b;
  transform: translate(2px, 2px);
  box-shadow: 1px 1px 0 #183d2c;
}

.create-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 18px;
  padding-bottom: 10px;
  border-bottom: 2px dotted #8ba878;
}

.section-header h2 {
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 20px;
  margin: 0;
}

.board-count {
  padding: 3px 7px;
  border: 1px solid #739568;
  background: #e7f0dc;
  color: #315638;
  font-family: 'Courier New', monospace;
  font-size: 11px;
}

.board-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 18px;
}

.board-card {
  overflow: hidden;
  border: 2px solid #426b44;
  border-radius: 2px;
  background: #fffef7;
  box-shadow: 3px 3px 0 #b4c99e;
  transition: transform 0.12s, box-shadow 0.12s;
}

.board-card:hover {
  transform: translate(-2px, -2px);
  box-shadow: 5px 5px 0 #b4c99e;
}

.board-preview {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 168px;
  border: none;
  border-bottom: 2px dotted #64885b;
  background-color: #edf4dc;
  background-image: radial-gradient(#c1d49f 1px, transparent 1px);
  background-size: 12px 12px;
  cursor: pointer;
}

.preview-icon {
  font-size: 44px;
  filter: drop-shadow(2px 2px 0 #fffdf1);
}

.preview-text {
  position: absolute;
  bottom: 16px;
  right: 16px;
  color: #315638;
  font-family: 'Courier New', monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0;
  padding: 4px 6px;
  border: 1px solid #739568;
  background: #fffdf1;
}

.card-content {
  padding: 15px;
}

.board-title {
  display: block;
  max-width: 100%;
  border: none;
  background: transparent;
  color: #183d2c;
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 17px;
  font-weight: 700;
  text-align: left;
  cursor: pointer;
  overflow-wrap: anywhere;
}

.board-title:hover {
  color: #b52f43;
  text-decoration: underline;
}

.updated-at {
  color: #68806a;
  font-family: 'Courier New', monospace;
  font-size: 10px;
  margin: 10px 0;
}

.shared-label {
  display: inline-block;
  padding: 4px 7px;
  border: 1px solid #4d8056;
  background: #e1f1d9;
  color: #285a3b;
  font-family: 'Courier New', monospace;
  font-size: 10px;
  font-weight: 700;
  margin-bottom: 12px;
}

.card-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

.card-actions button {
  border: 1px solid #547452;
  border-radius: 1px;
  padding: 7px 9px;
  font-family: 'Courier New', monospace;
  font-size: 11px;
  cursor: pointer;
}

.edit-button {
  background: #e6f0dc;
  color: #315638;
}

.delete-button {
  background: #f8e1d7;
  color: #a52e43;
}

.card-actions button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.state,
.empty-state {
  text-align: center;
  padding: 80px 20px;
  border: 2px dotted #77946b;
  border-radius: 2px;
  background-color: #fffef7;
  background-image: radial-gradient(#d8e3c8 1px, transparent 1px);
  background-size: 14px 14px;
}

.empty-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

.empty-state h3 {
  margin-bottom: 8px;
}

.empty-state p {
  color: #58715b;
  font-size: 14px;
  margin-bottom: 24px;
}

.error-message {
  padding: 14px 18px;
  border: 2px solid #a52e43;
  background: #f8e1d7;
  color: #8f2336;
  margin-bottom: 24px;
}

.dashboard * {
  font-family: 'DotGothic16', 'Courier New', monospace;
}

@media (max-width: 900px) {
  .board-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 600px) {
  .dashboard {
    padding: 28px 16px;
  }

  .container {
    padding: 20px;
    box-shadow: 5px 5px 0 #285a3b;
  }

  .header {
    flex-direction: column;
    align-items: stretch;
    margin: -20px -20px 28px;
    padding: 20px;
  }

  h1 {
    font-size: 30px;
  }

  .create-button {
    width: 100%;
  }

  .board-grid {
    grid-template-columns: 1fr;
  }
}
</style>
