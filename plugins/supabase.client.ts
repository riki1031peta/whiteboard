import { createClient } from '@supabase/supabase-js'

export default defineNuxtPlugin(() => {
  const config = useRuntimeConfig()

  console.log('Supabase設定確認:', {
    url: config.public.supabaseUrl,
    hasKey: Boolean(config.public.supabaseKey),
  })

  const supabase = createClient(
    config.public.supabaseUrl,
    config.public.supabaseKey
  )

  return {
    provide: {
      supabase,
    },
  }
})