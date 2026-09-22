import { useEffect, useState } from 'react'
import { View, Text, Input, Button } from '@tarojs/components'
import Taro from '@tarojs/taro'
import classnames from 'classnames'
import { getCore } from '../../services/synapse'
import { isOnboarded, markOnboarded } from '../../utils/prefs'
import styles from './index.module.scss'

const KEY_PAGE = 'https://platform.deepseek.com/api_keys'
const STEPS = [
  '打开 DeepSeek 开放平台，创建一个 API Key',
  '把 Key 粘贴到下面，点「校验并保存」',
  '校验通过后就能用完整 AI 能力；也可以先跳过，用本地规则模式体验'
]

export default function OnboardingPage() {
  const [apiKey, setApiKey] = useState('')
  const [checking, setChecking] = useState(false)
  const [errorText, setErrorText] = useState('')
  const [okText, setOkText] = useState('')

  useEffect(() => {
    if (isOnboarded()) {
      console.log('[Synapse] 已完成引导，直接进入对话')
      Taro.switchTab({ url: '/pages/chat/index' })
    }
  }, [])

  const enterApp = () => {
    markOnboarded()
    Taro.switchTab({ url: '/pages/chat/index' })
  }

  const copyKeyPage = async () => {
    try {
      await Taro.setClipboardData({ data: KEY_PAGE })
    } catch (error) {
      console.error('[Synapse] 复制失败', error)
    }
  }

  const validateAndSave = async () => {
    const key = apiKey.trim()
    if (!key) {
      setErrorText('请先粘贴 API Key')
      return
    }
    setChecking(true)
    setErrorText('')
    setOkText('')
    console.log('[Synapse] 校验 API Key')
    try {
      const result = await getCore().validateApiKey(key)
      if (!result.success) {
        console.error('[Synapse] Key 校验失败', result.message)
        setErrorText(result.message)
        return
      }
      const saved = getCore().saveApiKey(key)
      console.log('[Synapse] Key 已保存', saved.message)
      setOkText(saved.message)
      Taro.showToast({ title: '校验通过', icon: 'success' })
      setTimeout(enterApp, 600)
    } catch (error) {
      console.error('[Synapse] 校验异常', error)
      setErrorText(`校验失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setChecking(false)
    }
  }

  return (
    <View className={styles.page}>
      <View className={styles.hero}>
        <Text className={styles.brand}>Synapse</Text>
        <Text className={styles.slogan}>你的学习计划，从一个目标开始</Text>
      </View>

      <View className={styles.card}>
        <Text className={styles.cardTitle}>先配置 DeepSeek API Key</Text>
        <Text className={styles.cardDesc}>
          本应用不经过任何中间服务器：Key 只保存在这台设备的本地存储里，由设备直连模型商。
        </Text>

        <View className={styles.steps}>
          {STEPS.map((step, index) => (
            <View key={step} className={styles.stepRow}>
              <View className={styles.stepIndex}>
                <Text className={styles.stepIndexText}>{index + 1}</Text>
              </View>
              <Text className={styles.stepText}>{step}</Text>
            </View>
          ))}
        </View>

        <View className={styles.linkRow} onClick={copyKeyPage}>
          <Text className={styles.linkText}>复制 Key 获取地址</Text>
          <Text className={styles.linkValue}>{KEY_PAGE}</Text>
        </View>

        <Input
          className={styles.input}
          password
          placeholder="sk-..."
          value={apiKey}
          onInput={(event) => {
            setApiKey(String(event.detail.value))
            setErrorText('')
            setOkText('')
          }}
        />

        {!!errorText && <Text className={styles.error}>{errorText}</Text>}
        {!!okText && <Text className={styles.success}>{okText}</Text>}

        <Button
          className={classnames(styles.primaryButton, checking && styles.buttonDisabled)}
          disabled={checking}
          onClick={validateAndSave}
        >
          {checking ? '正在校验…' : '校验并保存'}
        </Button>

        <Button className={styles.ghostButton} onClick={enterApp}>
          先跳过，用本地规则模式体验
        </Button>

        <Text className={styles.note}>
          提示：在校验时如果报跨域或网络错误，通常是当前预览环境（浏览器）的限制；用手机预览或在微信后台把
          api.deepseek.com 加入 request 合法域名后即可正常。
        </Text>
      </View>
    </View>
  )
}
