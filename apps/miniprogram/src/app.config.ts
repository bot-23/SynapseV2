export default defineAppConfig({
  pages: [
    'pages/onboarding/index',
    'pages/chat/index',
    'pages/plan/index',
    'pages/mine/index',
    'pages/conversations/index',
    'pages/timetable/index',
    'pages/assignments/index',
    'pages/graph/index',
    'pages/errors/index',
    'pages/cloudcheck/index'
  ],
  // 资料库页单独放进分包：它要带 pdf.js（约 1.7MB），留在主包会把 2MB 主包上限顶爆。
  // 分包只在用户真的进资料库时才下载，主包因此保持在 1MB 以内。
  subPackages: [
    {
      root: 'packageDocuments',
      pages: ['index']
    }
  ],
  window: {
    backgroundTextStyle: 'light',
    navigationBarBackgroundColor: '#132239',
    navigationBarTitleText: 'Synapse 学习陪伴',
    navigationBarTextStyle: 'white',
    backgroundColor: '#f2f5f8'
  },
  tabBar: {
    color: '#6f7c8b',
    selectedColor: '#132239',
    backgroundColor: '#ffffff',
    borderStyle: 'white',
    list: [
      {
        pagePath: 'pages/chat/index',
        text: '对话',
        iconPath: 'assets/tabbar/chat.png',
        selectedIconPath: 'assets/tabbar/chat-selected.png'
      },
      {
        pagePath: 'pages/plan/index',
        text: '计划',
        iconPath: 'assets/tabbar/plan.png',
        selectedIconPath: 'assets/tabbar/plan-selected.png'
      },
      {
        pagePath: 'pages/mine/index',
        text: '我的',
        iconPath: 'assets/tabbar/mine.png',
        selectedIconPath: 'assets/tabbar/mine-selected.png'
      }
    ]
  }
})
