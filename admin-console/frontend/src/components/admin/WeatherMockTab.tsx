import { useCallback, useEffect, useState } from 'react'
import { ApiError, clearAdminWeatherMock, fetchAdminWeather, setAdminWeatherMock } from '../../api'
import { explain, useConsole } from '../../console/ConsoleContext'
import type { AdminWeather, WeatherMock, WeatherScenario } from '../../types'
import { readError } from '../format'

const SCENARIOS: Array<{ id: WeatherScenario; label: string; hint: string; temperature: number }> = [
  { id: 'sunny', label: 'Nắng', hint: 'Không mưa trong 3 ngày', temperature: 31 },
  { id: 'rain_soon', label: 'Sắp mưa', hint: 'Mưa sau vài giờ, kéo dài 4 giờ', temperature: 28 },
  { id: 'raining', label: 'Đang mưa', hint: 'Mưa ngay bây giờ, kéo dài 4 giờ', temperature: 25 },
  { id: 'heat', label: 'Nắng nóng', hint: 'Không mưa, nóng nhất khoảng 14 giờ', temperature: 37 },
]

const ERRORS: Record<string, string> = {
  WEATHER_NOT_MOCK: 'Gateway không chạy thời tiết giả lập (WEATHER_MODE khác mock).',
  WEATHER_PROVINCE_UNKNOWN: 'Không có tỉnh/thành phố này.',
}

const scenarioLabel = (id: WeatherScenario) => SCENARIOS.find((item) => item.id === id)?.label ?? id

function describe(mock: WeatherMock): string {
  const scenario = SCENARIOS.find((item) => item.id === mock.scenario)
  const parts = [`${mock.temperature ?? scenario?.temperature ?? '—'}°C`]
  if (mock.scenario === 'rain_soon') parts.push(`mưa sau ${mock.rain_in_hours ?? 2} giờ`)
  return parts.join(' · ')
}

/**
 * "Thời tiết giả lập": with WEATHER_MODE=mock the Gateway plays the weather
 * set here (per province or everywhere), so weather automations and the
 * assistant can be shown without waiting for real rain. Every change is logged.
 */
export function WeatherMockTab() {
  const access = useConsole()
  const canManage = access.can('simulator.manage')
  const [data, setData] = useState<AdminWeather | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [area, setArea] = useState('all')
  const [scenario, setScenario] = useState<WeatherScenario>('rain_soon')
  const [temperature, setTemperature] = useState('')
  const [rainIn, setRainIn] = useState('2')

  const load = useCallback(async () => {
    try {
      setData(await fetchAdminWeather())
      setError('')
    } catch (caught) {
      setError(readError(caught, 'Không tải được thời tiết giả lập.'))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const failed = (caught: unknown, fallback: string) =>
    setError(caught instanceof ApiError && caught.code && ERRORS[caught.code] ? ERRORS[caught.code] : explain(caught, fallback))

  const areaName = (code: string) => (code === 'all' ? 'Mọi nơi' : data?.provinces.find((item) => item.code === code)?.name ?? code)

  const apply = async () => {
    const mock: WeatherMock = { scenario }
    if (temperature.trim() !== '') mock.temperature = Number(temperature)
    if (scenario === 'rain_soon') mock.rain_in_hours = Number(rainIn)
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await setAdminWeatherMock(area, mock)
      setData((current) => (current ? { ...current, mocks: result.mocks } : current))
      setNotice(`${areaName(area)}: ${scenarioLabel(scenario)} (${describe(mock)}). Tự động hóa và trợ lý đọc thời tiết này ngay.`)
    } catch (caught) {
      failed(caught, 'Chưa đặt được thời tiết.')
    } finally {
      setBusy(false)
    }
  }

  const clear = async (code: string) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await clearAdminWeatherMock(code)
      setData((current) => (current ? { ...current, mocks: result.mocks } : current))
      setNotice(`${areaName(code)}: đã bỏ thời tiết giả lập.`)
    } catch (caught) {
      failed(caught, 'Chưa bỏ được.')
    } finally {
      setBusy(false)
    }
  }

  if (!data) {
    return error
      ? <p className="notice notice--error" role="alert">{error}</p>
      : <div className="registry-skeleton" aria-label="Đang tải thời tiết giả lập"><span /><span /></div>
  }

  const mock = data.mode === 'mock'
  const temperatureValid = temperature.trim() === '' || (Number.isFinite(Number(temperature)) && Number(temperature) >= -10 && Number(temperature) <= 50)
  const rainValid = scenario !== 'rain_soon' || (Number.isInteger(Number(rainIn)) && Number(rainIn) >= 1 && Number(rainIn) <= 12)
  const entries = Object.entries(data.mocks).sort(([a], [b]) => (a === 'all' ? -1 : b === 'all' ? 1 : areaName(a).localeCompare(areaName(b), 'vi')))
  const chosen = SCENARIOS.find((item) => item.id === scenario)!

  return (
    <section aria-labelledby="weather-title" className="registry-page console-page weather-mock">
      <header className="page-heading">
        <div>
          <h2 className="visually-hidden" id="weather-title">Thời tiết giả lập</h2>
          <p>
            Dùng khi demo hoặc kiểm thử: đặt trời nắng, sắp mưa, đang mưa hay nắng nóng cho một tỉnh hoặc mọi nơi. Tự động hóa có
            điều kiện thời tiết và trợ lý của các nhà ở đó đọc ngay thời tiết này. Mọi thay đổi được ghi vào nhật ký.
          </p>
        </div>
      </header>
      {!mock && (
        <p className="notice notice--warning" role="status">
          {data.mode === 'live'
            ? 'Gateway đang dùng dự báo thật từ Open-Meteo (WEATHER_MODE=live). Muốn giả lập, đặt WEATHER_MODE=mock cho API Gateway rồi khởi động lại.'
            : 'Thời tiết đang tắt trên Gateway (WEATHER_MODE=off): ứng dụng không hiện thời tiết và không dùng được điều kiện thời tiết.'}
        </p>
      )}
      {mock && !canManage && (
        <p className="notice notice--warning console-readonly">Bạn chỉ có quyền xem: đặt hoặc bỏ thời tiết giả lập cần quyền quản lý Simulator.</p>
      )}
      {error && <p className="notice notice--error" role="alert">{error}</p>}
      {notice && <p className="notice notice--success" role="status">{notice}</p>}

      {mock && canManage && (
        <form className="weather-mock__form" onSubmit={(event) => { event.preventDefault(); void apply() }}>
          <label className="field">
            <span>Khu vực</span>
            <select onChange={(event) => setArea(event.target.value)} value={area}>
              <option value="all">Mọi nơi</option>
              {data.provinces.map((province) => <option key={province.code} value={province.code}>{province.name}</option>)}
            </select>
            <small>Nhà được tính theo tỉnh gần nhất; tỉnh không đặt riêng dùng “Mọi nơi”.</small>
          </label>
          <fieldset className="chip-set">
            <legend>Tình huống</legend>
            {SCENARIOS.map((item) => (
              <label className="chip" key={item.id} title={item.hint}>
                <input checked={scenario === item.id} name="scenario" onChange={() => setScenario(item.id)} type="radio" value={item.id} />
                {item.label}
              </label>
            ))}
            <small className="field-help weather-mock__hint">{chosen.hint}.</small>
          </fieldset>
          <div className="weather-mock__numbers">
            <label className="field">
              <span>Nhiệt độ bây giờ (°C)</span>
              <input
                inputMode="decimal"
                max={50}
                min={-10}
                onChange={(event) => setTemperature(event.target.value)}
                placeholder={String(chosen.temperature)}
                step={0.5}
                type="number"
                value={temperature}
              />
              <small>{temperatureValid ? `Bỏ trống: ${chosen.temperature}°C.` : 'Từ -10 đến 50°C.'}</small>
            </label>
            {scenario === 'rain_soon' && (
              <label className="field">
                <span>Mưa sau (giờ)</span>
                <input max={12} min={1} onChange={(event) => setRainIn(event.target.value)} step={1} type="number" value={rainIn} />
                <small>{rainValid ? 'Từ 1 đến 12 giờ.' : 'Nhập số giờ từ 1 đến 12.'}</small>
              </label>
            )}
          </div>
          <div>
            <button className="button button--primary" disabled={busy || !temperatureValid || !rainValid} type="submit">
              {busy ? 'Đang áp dụng…' : 'Áp dụng'}
            </button>
          </div>
        </form>
      )}

      {mock && (
        <section>
          <h3 className="admin-subtitle">Đang giả lập</h3>
          {entries.length === 0 ? (
            <p className="empty-inline">Chưa đặt gì: mọi nơi là một ngày nắng 31°C.</p>
          ) : (
            <table className="data-table console-table">
              <thead>
                <tr>
                  <th scope="col">Khu vực</th>
                  <th scope="col">Tình huống</th>
                  <th scope="col">Chi tiết</th>
                  {canManage && <th scope="col"><span className="visually-hidden">Thao tác</span></th>}
                </tr>
              </thead>
              <tbody>
                {entries.map(([code, item]) => (
                  <tr key={code}>
                    <td>{areaName(code)}</td>
                    <td>{scenarioLabel(item.scenario)}</td>
                    <td className="cell-muted">{describe(item)}</td>
                    {canManage && (
                      <td>
                        <button className="button button--quiet button--compact" disabled={busy} onClick={() => void clear(code)} type="button">
                          Bỏ
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
      <p className="admin-footnote">
        Thời tiết giả lập bắt đầu từ lúc đặt và kéo dài 3 ngày (hôm nay và 2 ngày tới). Khi chạy thật (WEATHER_MODE=live), dữ liệu lấy từ
        Open-Meteo.com (CC BY 4.0).
      </p>
    </section>
  )
}
