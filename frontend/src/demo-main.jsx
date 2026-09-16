import React from 'react'
import ReactDOM from 'react-dom/client'
import DemoApp from './demo/DemoApp.jsx'
import { installDemoApi } from './demo/demoApi.js'

installDemoApi()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <DemoApp />
  </React.StrictMode>,
)
