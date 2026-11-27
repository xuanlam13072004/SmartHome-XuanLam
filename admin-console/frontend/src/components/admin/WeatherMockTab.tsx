import { useCallback, useEffect, useState } from 'react'
import {
  ApiError,
  clearAdminWeatherAccountMock,
  clearAdminWeatherMock,
  fetchAdminWeather,
  setAdminWeatherAccountMock,
  setAdminWeatherMock,
} from '../../api'
import { explain, useConsole } from '../../console/ConsoleContext'
import type { AdminWeather, WeatherAccountMock, WeatherLiveStatus, WeatherMock, WeatherScenario } from '../../types'
import { formatNumber, formatRelative, readError } from '../format'

const SCENARIOS: Array<{ id: WeatherScenario; label: string; hint: string; temperature: number }> = [
  { id: 'sunny', label: 'Nắng', hint: 'Không mưa trong 3 ngày', temperature: 31 },
  { id: 'rain_soon', label: 'Sắp mưa', hint: 'Mưa sau vài giờ, kéo dài 4 giờ', temperature: 28 },
  { id: 'raining', label: 'Đang mưa', hint: 'Mưa ngay bây giờ, kéo dài 4 giờ', temperature: 25 },
  { id: 'heat', label: 'Nắng nóng', hint: 'Không mưa, nóng nhất khoảng 14 giờ', temperature: 37 },
]

/** How long an account's mock lasts (the Gateway allows 1–24 hours; 2 by default). */
const HOURS = [1, 2, 4, 8, 24]

const ERRORS: Record<string, string> = {
  WEATHER_NOT_MOCK: 'Đặt theo tỉnh chỉ dùng được khi Gateway chạy WEATHER_MODE=mock; khi chạy thật, hãy đặt cho một tài khoản.',
  WEATHER_PROVINCE_UNKNOWN: 'Không có tỉnh/thành phố này.',
  WEATHER_OFF: 'Thời tiết đang tắt trên Gateway (WEATHER_MODE=off).',
  ACCOUNT_NOT_FOUND: 'Không có tài khoản nào dùng email này.',
}

type Target = 'account' | 'area'

const scenarioLabel = (id: WeatherScenario) => SCENARIOS.find((item) => item.id === id)?.label ?? id

function describe(mock: WeatherMock): string {
  const scenario = SCENARIOS.find((item) => item.id === mock.scenario)
  const parts = [`${mock.temperature ?? scenario?.temperature ?? '—'}°C`]
  if (mock.scenario === 'rain_soon') parts.push(`mưa sau ${mock.rain_in_hours ?? 2} giờ`)
  return parts.join(' · ')
}

const clock = (value: string) => new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value))

/** "còn 1 giờ 45 phút". */
function timeLeft(until: string, now: number): string {
  const minutes = Math.max(1, Math.ceil((Date.parse(until) - now) / 60_000))
  if (minutes < 60) return `còn ${minutes} phút`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `còn ${hours} giờ ${rest} phút` : `còn ${hours} giờ`
}

/**
 * "Thời tiết giả lập", for demos and tests instead of waiting for real rain.
 * For one account (live or mock; it ends by itself after the hours chosen):
 * that account's automations, assistant and app read it, every other account
 * keeps its weather. With WEATHER_MODE=mock also per province or everywhere.
 * Live, it shows how fresh the 63 areas' real forecasts are. Changes are logged.
 */
export function WeatherMockTab() {
  const access = useConsole()
  const canManage = access.can('simulator.manage')
  const [data, setData] = useState<AdminWeather | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [target, setTarget] = useState<Target>('account')
  const [email, setEmail] = useState('')
  const [hours, setHours] = useState('2')
  const [area, setArea] = useState('all')
  const [scenario, setScenario] = useState<WeatherScenario>('rain_soon')
  const [temperature, setTemperature] = useState('')
  const [rainIn, setRainIn] = useState('2')
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async () => {
    try {
      setData(await fetchAdminWeather())
      setError('')
    } catch (caught) {
      setError(readError(caught, 'Không tải được thời tiết giả lập.'))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // The time left of each account's mock, and mocks that have ended drop off the list.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const failed = (caught: unknown, fallback: string) =>
    setError(caught instanceof ApiError && caught.code && ERRORS[caught.code] ? ERRORS[caught.code] : explain(caught, fallback))

  const areaName = (code: string) => (code === 'all' ? 'Mọi nơi' : data?.provinces.find((item) => item.code === code)?.name ?? code)

  const run = async (action: () => Promise<void>, fallback: string) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (caught) {
      failed(caught, fallback)
    } finally {
      setBusy(false)
      setNow(Date.now())
    }
  }

  const apply = (byArea: boolean) => run(async () => {
    const mock: WeatherMock = { scenario }
    if (temperature.trim() !== '') mock.temperature = Number(temperature)
    if (scenario === 'rain_soon') mock.rain_in_hours = Number(rainIn)
    const what = `${scenarioLabel(scenario)} (${describe(mock)})`
    if (byArea) {
      const result = await setAdminWeatherMock(area, mock)
      setData((current) => (current ? { ...current, mocks: result.mocks } : current))
      setNotice(`${areaName(area)}: ${what}. Tự động hóa và trợ lý ở đó đọc thời tiết này ngay.`)
      return
    }
    const wanted = email.trim().toLowerCase()
    const result = await setAdminWeatherAccountMock({ email: wanted, ...mock, hours: Number(hours) })
    setData((current) => (current ? { ...current, accounts: result.accounts } : current))
    const entry = result.accounts.find((item) => item.email.toLowerCase() === wanted)
    setNotice(
      `${entry?.email ?? wanted}: ${what} đến ${entry ? clock(entry.expires_at) : '—'}. Chỉ tài khoản này thấy thời tiết giả lập.`
        + (entry && !entry.place ? ' Tài khoản chưa đặt vị trí nhà nên giả lập chưa có tác dụng.' : ''),
    )
  }, 'Chưa đặt được thời tiết.')

  const clearArea = (code: string) => run(async () => {
    const result = await clearAdminWeatherMock(code)
    setData((current) => (current ? { ...current, mocks: result.mocks } : current))
    setNotice(`${areaName(code)}: đã bỏ thời tiết giả lập.`)
  }, 'Chưa bỏ được.')

  const clearAccount = (item: WeatherAccountMock) => run(async () => {
    const result = await clearAdminWeatherAccountMock(item.account_id)
    setData((current) => (current ? { ...current, accounts: result.accounts } : current))
    setNotice(`${item.email}: đã kết thúc thời tiết giả lập, tài khoản dùng lại thời tiết thật.`)
  }, 'Chưa bỏ được.')

  if (!data) {
    return error
      ? <p className="notice notice--error" role="alert">{error}</p>
      : <div className="registry-skeleton" aria-label="Đang tải thời tiết giả lập"><span /><span /></div>
  }

  const off = data.mode === 'off'
  const mockMode = data.mode === 'mock'
  const byArea = mockMode && target === 'area'
  const temperatureValid = temperature.trim() === '' || (Number.isFinite(Number(temperature)) && Number(temperature) >= -10 && Number(temperature) <= 50)
  const rainValid = scenario !== 'rain_soon' || (Number.isInteger(Number(rainIn)) && Number(rainIn) >= 1 && Number(rainIn) <= 12)
  const emailValid = byArea || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  const accounts = data.accounts.filter((item) => Date.parse(item.expires_at) > now)
  const areas = Object.entries(data.mocks).sort(([a], [b]) => (a === 'all' ? -1 : b === 'all' ? 1 : areaName(a).localeCompare(areaName(b), 'vi')))
  const chosen = SCENARIOS.find((item) => item.id === scenario)!

  return (
    <section aria-labelledby="weather-title" className="registry-page console-page weather-mock">
      <header className="page-heading">
        <div>
          <h2 className="visually-hidden" id="weather-title">Thời tiết giả lập</h2>
          <p>
            Dùng khi demo hoặc kiểm thử: cho một tài khoản thấy trời nắng, sắp mưa, đang mưa hay nắng nóng mà không phải chờ thời
            tiết thật. Tự động hóa có điều kiện thời tiết, trợ lý và ứng dụng của tài khoản đó đọc ngay thời tiết này; các tài khoản
            khác vẫn dùng thời tiết của chúng. Giả lập tự kết thúc sau thời gian đã chọn. Mọi thay đổi được ghi vào nhật ký.
          </p>
        </div>
      </header>
      {off && (
        <p className="notice notice--warning" role="status">
          Thời tiết đang tắt trên Gateway (WEATHER_MODE=off): ứng dụng không hiện thời tiết và không dùng được điều kiện thời tiết.
        </p>
      )}
      {data.live && <LiveStatus status={data.live} />}
      {mockMode && (
        <p className="notice" role="status">
          Gateway đang chạy thời tiết giả lập cho cả hệ thống (WEATHER_MODE=mock): ngoài từng tài khoản, có thể đặt theo tỉnh hoặc
          mọi nơi.
        </p>
      )}
      {!off && !canManage && (
        <p className="notice notice--warning console-readonly">Bạn chỉ có quyền xem: đặt hoặc bỏ thời tiết giả lập cần quyền quản lý Simulator.</p>
      )}
      {error && <p className="notice notice--error" role="alert">{error}</p>}
      {notice && <p className="notice notice--success" role="status">{notice}</p>}

      {!off && canManage && (
        <form className="weather-mock__form" onSubmit={(event) => { event.preventDefault(); void apply(byArea) }}>
          {mockMode && (
            <fieldset className="chip-set">
              <legend>Áp dụng cho</legend>
              <label className="chip">
                <input checked={target === 'account'} name="target" onChange={() => setTarget('account')} type="radio" value="account" />
                Một tài khoản
              </label>
              <label className="chip">
                <input checked={target === 'area'} name="target" onChange={() => setTarget('area')} type="radio" value="area" />
                Tỉnh hoặc mọi nơi
              </label>
            </fieldset>
          )}
          {byArea ? (
            <label className="field">
              <span>Khu vực</span>
              <select onChange={(event) => setArea(event.target.value)} value={area}>
                <option value="all">Mọi nơi</option>
                {data.provinces.map((province) => <option key={province.code} value={province.code}>{province.name}</option>)}
              </select>
              <small>Nhà ở khu vực nào thì theo tỉnh chứa khu vực đó; tỉnh không đặt riêng dùng “Mọi nơi”.</small>
            </label>
          ) : (
            <div className="weather-mock__who">
              <label className="field">
                <span>Email tài khoản</span>
                <input
                  autoComplete="off"
                  inputMode="email"
                  maxLength={320}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="demo@example.com"
                  spellCheck={false}
                  type="email"
                  value={email}
                />
                <small>Tài khoản cần đã đặt vị trí nhà trong ứng dụng.</small>
              </label>
              <label className="field">
                <span>Kết thúc sau</span>
                <select onChange={(event) => setHours(event.target.value)} value={hours}>
                  {HOURS.map((value) => <option key={value} value={value}>{value} giờ</option>)}
                </select>
                <small>{mockMode ? 'Rồi dùng lại thời tiết giả lập theo tỉnh.' : 'Rồi tự dùng lại thời tiết thật.'}</small>
              </label>
            </div>
          )}
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
            <button className="button button--primary" disabled={busy || !temperatureValid || !rainValid || !emailValid} type="submit">
              {busy ? 'Đang áp dụng…' : 'Áp dụng'}
            </button>
          </div>
        </form>
      )}

      {!off && (
        <section>
          <h3 className="admin-subtitle">Đang giả lập cho tài khoản</h3>
          {accounts.length === 0 ? (
            <p className="empty-inline">Chưa có tài khoản nào: mọi tài khoản đang dùng {mockMode ? 'thời tiết giả lập theo tỉnh' : 'thời tiết thật'}.</p>
          ) : (
            <table className="data-table console-table">
              <thead>
                <tr>
                  <th scope="col">Tài khoản</th>
                  <th scope="col">Vị trí nhà</th>
                  <th scope="col">Tình huống</th>
                  <th scope="col">Kết thúc</th>
                  {canManage && <th scope="col"><span className="visually-hidden">Thao tác</span></th>}
                </tr>
              </thead>
              <tbody>
                {accounts.map((item) => (
                  <tr key={item.account_id}>
                    <td>{item.email}<small className="cell-muted"> · {item.full_name}</small></td>
                    <td>
                      {item.place ?? (
                        <span className="cell-error" title="Chưa đặt vị trí nhà: tự động hóa và trợ lý chưa đọc được thời tiết">
                          Chưa đặt: chưa có tác dụng
                        </span>
                      )}
                    </td>
                    <td>{scenarioLabel(item.scenario)}<small className="cell-muted"> · {describe(item)}</small></td>
                    <td>{timeLeft(item.expires_at, now)}<small className="cell-muted"> · {clock(item.expires_at)}</small></td>
                    {canManage && (
                      <td>
                        <button className="button button--quiet button--compact" disabled={busy} onClick={() => void clearAccount(item)} type="button">
                          Kết thúc
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

      {mockMode && (
        <section>
          <h3 className="admin-subtitle">Đang giả lập theo tỉnh</h3>
          {areas.length === 0 ? (
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
                {areas.map(([code, item]) => (
                  <tr key={code}>
                    <td>{areaName(code)}</td>
                    <td>{scenarioLabel(item.scenario)}</td>
                    <td className="cell-muted">{describe(item)}</td>
                    {canManage && (
                      <td>
                        <button className="button button--quiet button--compact" disabled={busy} onClick={() => void clearArea(code)} type="button">
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
        {/* One child: the footnote is a flex row. */}
        <span>
          Thời tiết giả lập luôn tính từ lúc xem: “Sắp mưa sau 2 giờ” vẫn là sắp mưa cho đến khi kết thúc. Khi chạy thật
          (WEATHER_MODE=live), dữ liệu thời tiết lấy từ{' '}
          <a href="https://open-meteo.com/" rel="noreferrer" target="_blank">Open-Meteo.com</a> (
          <a href="https://creativecommons.org/licenses/by/4.0/" rel="noreferrer" target="_blank">CC BY 4.0</a>).
        </span>
      </p>
    </section>
  )
}

/** Live mode: are the 63 areas' forecasts fresh, and how many Open-Meteo calls today. */
function LiveStatus({ status }: { status: WeatherLiveStatus }) {
  const stale = status.areas - status.fresh_areas
  const share = status.daily_call_limit > 0 ? status.calls_today / status.daily_call_limit : 1
  return (
    <section aria-label="Dự báo thật">
      <p className="notice" role="status">
        Gateway đang dùng dự báo thật từ Open-Meteo (WEATHER_MODE=live): {status.areas} khu vực (63 tỉnh, thành cũ) được làm mới
        mỗi {status.refresh_minutes} phút, dù có bao nhiêu người dùng. Ở chế độ này chỉ giả lập được cho từng tài khoản.
      </p>
      <dl className="live-grid">
        <div className={`live-metric${stale > 0 ? ' live-metric--error' : ''}`}>
          <dt>Khu vực có dự báo</dt>
          <dd><strong>{status.fresh_areas}/{status.areas}</strong></dd>
          <dd className="live-metric__note">{stale > 0 ? `${stale} khu vực chưa có hoặc đã cũ quá 3 giờ` : 'Tất cả còn mới'}</dd>
        </div>
        <div className="live-metric">
          <dt>Làm mới lần cuối</dt>
          <dd><strong>{status.refreshed_at ? clock(status.refreshed_at) : '—'}</strong></dd>
          <dd className="live-metric__note">
            {status.refreshed_at ? `${formatRelative(status.refreshed_at)} · ` : 'Chưa có lần nào · '}lỗi thì thử lại sau 5, 10, 20… phút
          </dd>
        </div>
        <div className={`live-metric${share >= 0.9 ? ' live-metric--error' : ''}`}>
          <dt>Lượt gọi hôm nay</dt>
          <dd><strong>{formatNumber(status.calls_today)}</strong></dd>
          <dd className="live-metric__note">Trần {formatNumber(status.daily_call_limit)}/ngày (bản miễn phí: 10.000)</dd>
        </div>
      </dl>
    </section>
  )
}
