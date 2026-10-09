import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Font tự host (không gọi Google Fonts), chỉ lấy bộ chữ Latin và tiếng Việt.
import '@fontsource/be-vietnam-pro/latin-400.css'
import '@fontsource/be-vietnam-pro/vietnamese-400.css'
import '@fontsource/be-vietnam-pro/latin-500.css'
import '@fontsource/be-vietnam-pro/vietnamese-500.css'
import '@fontsource/be-vietnam-pro/latin-600.css'
import '@fontsource/be-vietnam-pro/vietnamese-600.css'
import '@fontsource/be-vietnam-pro/latin-700.css'
import '@fontsource/be-vietnam-pro/vietnamese-700.css'
import '@fontsource/be-vietnam-pro/latin-800.css'
import '@fontsource/be-vietnam-pro/vietnamese-800.css'
import './index.css'
import App from './App.tsx'
import { loadToneModel } from './core/toneModel'

// Bảng thanh điệu học từ bài hát (nếu đã train và đặt vào public/models). Không có thì dùng luật sẵn có.
void loadToneModel()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
