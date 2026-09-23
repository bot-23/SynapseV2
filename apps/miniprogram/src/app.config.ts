export default defineAppConfig({
  pages: [
    'pages/onboarding/index',
    'pages/chat/index',
    'pages/plan/index',
    'pages/mine/index',
    'pages/conversations/index',
    'pages/timetable/index',
    'pages/documents/index',
    'pages/assignments/index',
    'pages/graph/index',
    'pages/cloudcheck/index'
  ],
  window: {
    backgroundTextStyle: 'light',
    navigationBarBackgroundColor: '#5b6cff',
    navigationBarTitleText: 'Synapse 学习陪伴',
    navigationBarTextStyle: 'white',
    backgroundColor: '#f4f5fa'
  },
  tabBar: {
    color: '#86909c',
    selectedColor: '#5b6cff',
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
