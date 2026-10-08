<script setup lang="ts">
const status = ref('画面の読み込み成功')

onMounted(async () => {
  status.value = 'onMounted実行成功'

  try {
    const { $supabase } = useNuxtApp()

    if (!$supabase) {
      status.value = 'Supabaseプラグインが見つかりません'
      return
    }

    status.value = 'Supabaseプラグイン取得成功'

    const { data, error } = await $supabase.auth.getSession()

    if (error) {
      status.value = `認証エラー: ${error.message}`
      return
    }

    status.value = 'Supabaseクライアントの初期化成功！'
    console.log('Session:', data.session)
  } catch (error) {
    console.error(error)
    status.value = `エラー: ${String(error)}`
  }
})
</script>

<template>
  <ClientOnly>
    <BoardCanvas />
  </ClientOnly>
</template>