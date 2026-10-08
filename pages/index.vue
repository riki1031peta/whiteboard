
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
* {
  box-sizing: border-box;
}

.dashboard {
  min-height: 100dvh;
  background: #f8fafc;
  color: #0f172a;
  padding: 48px 24px;
}

.container {
  max-width: 1100px;
  margin: 0 auto;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 56px;
}

.eyebrow {
  color: #2563eb;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 2px;
  margin-bottom: 12px;
}

h1 {
  font-size: clamp(28px, 5vw, 42px);
  font-weight: 800;
  margin: 0 0 12px;
}

.description {
  color: #64748b;
  font-size: 15px;
  line-height: 1.7;
}

.create-button {
  flex-shrink: 0;
  border: none;
  border-radius: 12px;
  background: #2563eb;
  color: #fff;
  padding: 14px 22px;
  font-size: 14px;
  font-weight: 700;
  cursor: pointer;
  transition: 0.2s;
}

.create-button:hover {
  background: #1d4ed8;
  transform: translateY(-2px);
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
  margin-bottom: 24px;
}

.section-header h2 {
  font-size: 21px;
  margin: 0;
}

.board-count {
  padding: 4px 10px;
  border-radius: 20px;
  background: #e2e8f0;
  color: #475569;
  font-size: 12px;
}

.board-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 24px;
}

.board-card {
  overflow: hidden;
  border-radius: 16px;
  background: #fff;
  border: 1px solid #e2e8f0;
  transition: 0.2s;
}

.board-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 10px 30px #0000000d;
}

.board-preview {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 180px;
  border: none;
  background: linear-gradient(135deg, #eff6ff, #f1f5f9);
  cursor: pointer;
}

.preview-icon {
  font-size: 50px;
}

.preview-text {
  position: absolute;
  bottom: 16px;
  right: 16px;
  color: #64748b;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 1px;
}

.card-content {
  padding: 20px;
}

.board-title {
  display: block;
  max-width: 100%;
  border: none;
  background: transparent;
  color: #0f172a;
  font-size: 17px;
  font-weight: 700;
  text-align: left;
  cursor: pointer;
  overflow-wrap: anywhere;
}

.board-title:hover {
  color: #2563eb;
}

.updated-at {
  color: #94a3b8;
  font-size: 12px;
  margin: 12px 0;
}

.shared-label {
  display: inline-block;
  padding: 5px 10px;
  border-radius: 20px;
  background: #dcfce7;
  color: #15803d;
  font-size: 11px;
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
  border: none;
  border-radius: 8px;
  padding: 9px 12px;
  font-size: 12px;
  cursor: pointer;
}

.edit-button {
  background: #f1f5f9;
  color: #475569;
}

.delete-button {
  background: #fee2e2;
  color: #dc2626;
}

.card-actions button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.state,
.empty-state {
  text-align: center;
  padding: 80px 20px;
  border: 1px dashed #cbd5e1;
  border-radius: 16px;
  background: #fff;
}

.empty-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

.empty-state h3 {
  margin-bottom: 8px;
}

.empty-state p {
  color: #64748b;
  font-size: 14px;
  margin-bottom: 24px;
}

.error-message {
  padding: 14px 18px;
  border-radius: 10px;
  background: #fee2e2;
  color: #b91c1c;
  margin-bottom: 24px;
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

  .header {
    flex-direction: column;
    align-items: stretch;
    margin-bottom: 36px;
  }

  .create-button {
    width: 100%;
  }

  .board-grid {
    grid-template-columns: 1fr;
  }
}
</style>
