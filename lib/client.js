// dsh-step-governor 客户端半边：在 DSH 设置面板里挂一个「步数治理」页签。
// 表单完全由 host 侧 GET /plugins/step-governor/settings 返回的 schema 驱动
// （字段约定 key/label/type/min/max/options/group/hint），改完 POST 回去即时
// 生效——host 侧 applySettings 会立刻重算 CONFIG，无需重启宿主。
//
// 格式说明：dsh 的 web client 模块必须手写 window.__ModuleLoader__.load({id,factory})
// 壳。打包器把各插件的 client.js 原样拼进 /plugins/?? combo，不会再补函数壳；
// 若在文件顶层直接 `return {...}`，拼进 bundle 后会落在脚本顶层作用域
// → SyntaxError: Illegal return statement → 整个 client bundle 解析失败
// → 页面「Failed to load plugins」。故此处必须保持 shell 形态。
//
// 颜色：只使用 dsh 官方主题变量 --dsw-alias-*，并带深色兜底值，
// 避免主题变量缺失时退化成白底白字。
window.__ModuleLoader__.load({
  id: 'dsh-step-governor',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    var THEME = {
      surface: 'var(--dsw-alias-bg-layer-1, #23262e)',
      surfaceRaised: 'var(--dsw-alias-bg-layer-2, #2b2f38)',
      border: 'var(--dsw-alias-border-l1, #3a3f4b)',
      borderStrong: 'var(--dsw-alias-border-l2, #4a5160)',
      text: 'var(--dsw-alias-label-primary, #e6e8ee)',
      textSecondary: 'var(--dsw-alias-label-secondary, #a8adba)',
      textTertiary: 'var(--dsw-alias-label-tertiary, #7d8391)',
      accent: 'var(--dsw-alias-brand-primary, #4a9eff)',
      accentInverted: 'var(--dsw-alias-brand-primary-invert, #ffffff)',
      danger: 'var(--dsw-alias-state-error-primary, #e0524a)',
      success: 'var(--dsw-alias-state-success-primary, #3f9d5a)'
    }

    var SETTINGS_API = '/plugins/step-governor/settings'

    function numberInputStyle() {
      return {
        width: 110,
        padding: '4px 8px',
        background: THEME.surfaceRaised,
        color: THEME.text,
        border: '1px solid ' + THEME.borderStrong,
        borderRadius: 4
      }
    }

    function textInputStyle() {
      return {
        width: '100%',
        maxWidth: 380,
        padding: '4px 8px',
        background: THEME.surfaceRaised,
        color: THEME.text,
        border: '1px solid ' + THEME.borderStrong,
        borderRadius: 4
      }
    }

    function selectStyle() {
      return {
        padding: '4px 8px',
        background: THEME.surfaceRaised,
        color: THEME.text,
        border: '1px solid ' + THEME.borderStrong,
        borderRadius: 4
      }
    }

    function primaryButtonStyle() {
      return {
        padding: '6px 16px',
        background: THEME.accent,
        color: THEME.accentInverted,
        border: 'none',
        borderRadius: 4,
        cursor: 'pointer'
      }
    }

    function secondaryButtonStyle() {
      return {
        padding: '6px 16px',
        background: THEME.surfaceRaised,
        color: THEME.text,
        border: '1px solid ' + THEME.borderStrong,
        borderRadius: 4,
        cursor: 'pointer'
      }
    }

    function checkboxStyle() {
      return { width: 16, height: 16, cursor: 'pointer', accentColor: THEME.accent }
    }

    /** 多选项取值归一为数组（notifyChannels 等）。 */
    function asArray(value) {
      return Array.isArray(value) ? value.slice() : []
    }

    /** 单个 schema 项的控件（boolean/number/text/select/multi-select）。 */
    function Control(props) {
      var spec = props.spec
      var value = props.value
      var onChange = props.onChange
      var type = spec.type || 'text'

      if (type === 'boolean') {
        return h('input', {
          type: 'checkbox',
          checked: value === true,
          style: checkboxStyle(),
          onChange: function (e) { onChange(e.target.checked) }
        })
      }

      if (type === 'number') {
        return h('input', {
          type: 'number',
          value: value === undefined || value === null ? '' : String(value),
          min: spec.min,
          max: spec.max,
          style: numberInputStyle(),
          onChange: function (e) {
            var raw = e.target.value
            onChange(raw === '' ? '' : Number(raw))
          }
        })
      }

      if (type === 'select') {
        var options = spec.options || []
        var expOpts = spec.experimentalOptions || []
        var isExperimental = expOpts.indexOf(value) >= 0
        var expWarn = null
        if (isExperimental) {
          expWarn = h('div', {
            style: {
              margin: '4px 0 0',
              fontSize: 12,
              color: THEME.danger,
              border: '1px solid ' + THEME.danger,
              borderRadius: 4,
              padding: '4px 8px',
              background: 'var(--dsw-alias-state-error-bg, rgba(224,82,74,0.12))'
            }
          }, (spec.experimentalNote || '') + ' 当前为实验性强制档，未经影子期零误杀验证，请勿用于生产拦截。')
        }
        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column' } },
          [
            h(
              'select',
              {
                value: value === undefined || value === null ? '' : String(value),
                style: isExperimental ? Object.assign(selectStyle(), { borderColor: THEME.danger }) : selectStyle(),
                onChange: function (e) { onChange(e.target.value) }
              },
              options.map(function (opt) {
                var val = opt && typeof opt === 'object' ? opt.value : opt
                var lab = opt && typeof opt === 'object' && opt.label ? opt.label : opt
                return h('option', { key: val, value: val }, lab)
              })
            ),
            expWarn
          ]
        )
      }

      if (type === 'multi-select') {
        var options2 = spec.options || []
        var selected = asArray(value)
        return h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: 12 } },
          options2.map(function (opt) {
            var val = opt && typeof opt === 'object' ? opt.value : opt
            var lab = opt && typeof opt === 'object' && opt.label ? opt.label : opt
            return h(
              'label',
              {
                key: val,
                style: {
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  color: THEME.text,
                  cursor: 'pointer'
                }
              },
              [
                h('input', {
                  key: 'c',
                  type: 'checkbox',
                  checked: selected.indexOf(val) >= 0,
                  style: checkboxStyle(),
                  onChange: function (e) {
                    var next = asArray(value)
                    var idx = next.indexOf(val)
                    if (e.target.checked) {
                      if (idx < 0) next.push(val)
                    } else if (idx >= 0) {
                      next.splice(idx, 1)
                    }
                    onChange(next)
                  }
                }),
                h('span', { key: 't' }, lab)
              ]
            )
          })
        )
      }

      return h('input', {
        type: 'text',
        value: value === undefined || value === null ? '' : String(value),
        style: textInputStyle(),
        onChange: function (e) { onChange(e.target.value) }
      })
    }

    /** 按 group 归并 schema（保持首次出现顺序）。 */
    function collectGroups(schema) {
      var groups = []
      var index = {}
      for (var i = 0; i < schema.length; i++) {
        var spec = schema[i]
        var name = spec.group || '其他'
        if (!index[name]) {
          index[name] = { name: name, items: [] }
          groups.push(index[name])
        }
        index[name].items.push(spec)
      }
      return groups
    }

    function StepGovernorPanel() {
      var payloadState = React.useState(null)
      var payload = payloadState[0]
      var setPayload = payloadState[1]

      var draftState = React.useState({})
      var draft = draftState[0]
      var setDraft = draftState[1]

      var loadingState = React.useState(true)
      var loading = loadingState[0]
      var setLoading = loadingState[1]

      var savingState = React.useState(false)
      var saving = savingState[0]
      var setSaving = savingState[1]

      var noticeState = React.useState('')
      var notice = noticeState[0]
      var setNotice = noticeState[1]

      var errorState = React.useState('')
      var errorMessage = errorState[0]
      var setErrorMessage = errorState[1]

      function load() {
        fetch(SETTINGS_API)
          .then(function (res) { return res.json() })
          .then(function (body) {
            if (!body || body.ok !== true) {
              setErrorMessage('读取设置失败：' + ((body && body.error) || '未知错误'))
            } else {
              setPayload(body)
              setDraft(Object.assign({}, body.settings))
              setErrorMessage('')
            }
            setLoading(false)
          })
          .catch(function (err) {
            setErrorMessage('读取设置失败：' + (err && err.message ? err.message : String(err)))
            setLoading(false)
          })
      }

      React.useEffect(load, [])

      function persist() {
        setSaving(true)
        setNotice('')
        fetch(SETTINGS_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings: draft })
        })
          .then(function (res) { return res.json() })
          .then(function (body) {
            if (!body || body.ok !== true) {
              var detail = body && body.errors && body.errors.length
                ? body.errors.join('；')
                : ((body && body.error) || '未知错误')
              setErrorMessage('保存失败：' + detail)
              return
            }
            setErrorMessage('')
            setDraft(Object.assign({}, body.settings))
            setPayload(function (prev) {
              return Object.assign({}, prev, { settings: body.settings })
            })
            var warns = body.warnings && body.warnings.length
              ? '（' + body.warnings.join('；') + '）'
              : ''
            setNotice(
              (body.saved === false ? '已生效，但写入配置文件失败（重启后会恢复）' : '已保存并即时生效') + warns
            )
          })
          .catch(function (err) {
            setErrorMessage('保存失败：' + (err && err.message ? err.message : String(err)))
          })
          .then(function () { setSaving(false) })
      }

      if (loading) {
        return h('div', { style: { padding: 16, color: THEME.textSecondary } }, '正在读取设置…')
      }
      if (!payload) {
        return h('div', { style: { padding: 16, color: THEME.danger } }, errorMessage || '设置不可用')
      }

      var schema = payload.schema || []
      var groups = collectGroups(schema)
      var dirty = JSON.stringify(draft) !== JSON.stringify(payload.settings || {})

      var children = []

      children.push(
        h('div', { key: 'head', style: { marginBottom: 14 } }, [
          h('div', { key: 't', style: { fontSize: 14, fontWeight: 600 } }, '步数治理'),
          h(
            'div',
            {
              key: 'd',
              style: { fontSize: 12, color: THEME.textTertiary, marginTop: 4, lineHeight: 1.7 }
            },
            '这个开关可以让 AI 在干活时自动识别“卡死”并中止，避免空转浪费算力。' +
              '它会同时盯两件事：一是 AI 整个回合完全没产出（连续空转），二是某次工具调用反复失败。' +
              '默认“仅观测不拦截”，先只记录不打扰，确认不会误伤后再逐步加码。'
          )
        ])
      )

      groups.forEach(function (group, gi) {
        children.push(
          h('div', { key: 'g' + gi, style: { marginBottom: 14 } }, [
            h(
              'div',
              {
                key: 'h',
                style: {
                  fontSize: 12,
                  fontWeight: 600,
                  color: THEME.textSecondary,
                  marginBottom: 6,
                  paddingBottom: 4,
                  borderBottom: '1px solid ' + THEME.border
                }
              },
              group.name
            ),
            h(
              'div',
              { key: 'b' },
              group.items.map(function (spec) {
                return h(
                  'div',
                  {
                    key: spec.key,
                    style: { display: 'flex', alignItems: 'flex-start', gap: 12, padding: '6px 0' }
                  },
                  [
                    h('div', { key: 'l', style: { width: 220, flexShrink: 0 } }, [
                      h('div', { key: 'n', style: { fontSize: 13, color: THEME.text } }, spec.label || spec.key),
                      spec.hint
                        ? h(
                            'div',
                            {
                              key: 'h',
                              style: {
                                fontSize: 11,
                                color: THEME.textTertiary,
                                marginTop: 2,
                                lineHeight: 1.6
                              }
                            },
                            spec.hint
                          )
                        : null
                    ]),
                    h(
                      'div',
                      { key: 'c', style: { flex: 1, paddingTop: 2 } },
                      h(Control, {
                        spec: spec,
                        value: draft[spec.key],
                        onChange: function (v) {
                          setDraft(function (prev) {
                            var next = Object.assign({}, prev)
                            next[spec.key] = v
                            return next
                          })
                          setNotice('')
                        }
                      })
                    )
                  ]
                )
              })
            )
          ])
        )
      })

      var pending = payload.pendingDependencies || []
      if (pending.length > 0) {
        children.push(
          h(
            'div',
            {
              key: 'pd',
              style: {
                marginTop: 4,
                marginBottom: 12,
                padding: 10,
                background: THEME.surfaceRaised,
                border: '1px solid ' + THEME.border,
                borderRadius: 4
              }
            },
            [
              h(
                'div',
                {
                  key: 'h',
                  style: { fontSize: 12, fontWeight: 600, color: THEME.textSecondary, marginBottom: 6 }
                },
                '待接线依赖（' + pending.length + ' 项，当前如实挂起、不伪造通过）'
              ),
              h(
                'div',
                { key: 'b' },
                pending.map(function (item, ii) {
                  return h(
                    'div',
                    {
                      key: 'p' + ii,
                      style: {
                        fontSize: 11,
                        color: THEME.textTertiary,
                        lineHeight: 1.7,
                        marginTop: ii === 0 ? 0 : 4
                      }
                    },
                    '· ' + (item.item || '') + ' ← ' + (item.dependsOn || '') + '：' + (item.reason || '')
                  )
                })
              )
            ]
          )
        )
      }

      children.push(
        h(
          'div',
          {
            key: 'foot',
            style: {
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 12,
              marginTop: 8,
              paddingTop: 12,
              borderTop: '1px solid ' + THEME.border
            }
          },
          [
            h(
              'button',
              {
                key: 's',
                style: primaryButtonStyle(),
                disabled: saving,
                onClick: persist
              },
              saving ? '保存中…' : '保存并即时生效'
            ),
            h(
              'button',
              {
                key: 'r',
                style: secondaryButtonStyle(),
                onClick: function () {
                  load()
                  setNotice('')
                }
              },
              '重新读取'
            ),
            dirty
              ? h(
                  'span',
                  { key: 'd', style: { fontSize: 12, color: THEME.textTertiary } },
                  '有未保存的改动'
                )
              : null,
            notice
              ? h('span', { key: 'n', style: { fontSize: 12, color: THEME.success } }, notice)
              : null,
            errorMessage
              ? h('span', { key: 'e', style: { fontSize: 12, color: THEME.danger } }, errorMessage)
              : null,
            payload.persisted === false
              ? h(
                  'span',
                  { key: 'p', style: { fontSize: 12, color: THEME.textTertiary } },
                  '（配置文件缺失或损坏，当前用默认值 + env 启动）'
                )
              : null
          ]
        )
      )

      return h('div', { style: { color: THEME.text } }, children)
    }

    function apply(ctx) {
      var slots = ctx.slots

      slots.inject('settings.section', function () {
        slots.register(
          { name: 'settings.section', id: 'step-governor', label: '步数治理', order: 996 },
          StepGovernorPanel
        )
      })
    }

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  }
})
