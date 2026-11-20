// 每个指标固定使用一个分类色槽（--series-N），顺序固定、不循环
// unit: 'kb' 表示 vmstat 输出单位是 KiB，页面会换算成 MB / GB 显示
var descriptions = {
    'Processes': {
        title: '进程 Processes',
        desc: '当前有多少进程在排队等 CPU、多少在等磁盘等 IO。',
        stats: {
            'r': { label: '运行队列', unit: '个', en: 'Number of processes waiting for run time',
                   desc: '正在运行或排队等待 CPU 的进程数。长期大于 CPU 核数说明 CPU 忙不过来。' },
            'b': { label: '阻塞进程', unit: '个', en: 'Number of processes in uninterruptible sleep',
                   desc: '处于不可中断睡眠的进程数，通常是在等磁盘 IO。经常不为 0 说明磁盘可能是瓶颈。' }
        }
    },
    'Memory': {
        title: '内存 Memory',
        desc: '内存使用情况（vmstat 原始单位为 KB，这里已换算）。Linux 会把空闲内存用作缓存，free 小通常是正常的。',
        stats: {
            'swpd':  { label: '已用交换', unit: 'kb', en: 'Amount of virtual memory used',
                       desc: '已经被放到硬盘交换区（swap）里的内存量。为 0 表示没有用到 swap。' },
            'free':  { label: '空闲内存', unit: 'kb', en: 'Amount of idle memory',
                       desc: '完全没被使用的物理内存。' },
            'buff':  { label: '缓冲区', unit: 'kb', en: 'Amount of memory used as buffers',
                       desc: '内核用于缓存磁盘元数据（如目录、文件属性）的内存，需要时可回收。' },
            'cache': { label: '页缓存', unit: 'kb', en: 'Amount of memory used as cache',
                       desc: '用来缓存文件内容的内存，让读文件更快；程序需要内存时可随时释放。' }
        }
    },
    'Swap': {
        title: '交换 Swap',
        desc: '内存和硬盘交换区之间的数据搬运量（每秒）。理想情况下两者都应为 0。',
        stats: {
            'si': { label: '换入', unit: 'KB/s', en: 'Amount of memory swapped in from disk',
                    desc: '每秒从硬盘交换区读回内存的数据量。' },
            'so': { label: '换出', unit: 'KB/s', en: 'Amount of memory swapped to disk',
                    desc: '每秒从内存写到硬盘交换区的数据量。持续大于 0 说明物理内存不够了。' }
        }
    },
    'IO': {
        title: '磁盘 IO',
        desc: '块设备（磁盘）的读写量，单位是块/秒（通常 1 块 = 1KB）。',
        stats: {
            'bi': { label: '读入', unit: '块/秒', en: 'Blocks received from a block device (blocks/s)',
                    desc: '每秒从磁盘读取的块数。' },
            'bo': { label: '写出', unit: '块/秒', en: 'Blocks sent to a block device (blocks/s)',
                    desc: '每秒写入磁盘的块数。' }
        }
    },
    'System': {
        title: '系统 System',
        desc: '内核层面的活跃程度。数值高低要结合平时基线来看，单看一个数意义不大。',
        stats: {
            'in': { label: '中断', unit: '次/秒', en: 'Number of interrupts per second, including the clock',
                    desc: '每秒硬件中断次数（含时钟中断），网卡、磁盘等设备都会触发。' },
            'cs': { label: '上下文切换', unit: '次/秒', en: 'Number of context switches per second',
                    desc: 'CPU 每秒在不同进程/线程之间切换的次数。异常飙高可能是线程过多或锁竞争。' }
        }
    },
    'CPU': {
        title: 'CPU 时间占比',
        desc: 'CPU 时间花在了哪里，单位是百分比，各项加起来约等于 100%。',
        maxValue: 100,
        stats: {
            'us': { label: '用户态', unit: '%', en: 'Time spent running non-kernel code (user time, including nice time)',
                    desc: '运行普通程序（你的应用、数据库等）所用的时间。' },
            'sy': { label: '内核态', unit: '%', en: 'Time spent running kernel code (system time)',
                    desc: '运行操作系统内核代码（系统调用、网络收发等）所用的时间。' },
            'id': { label: '空闲', unit: '%', en: 'Time spent idle',
                    desc: 'CPU 无事可做的时间。越高越清闲。' },
            'wa': { label: 'IO 等待', unit: '%', en: 'Time spent waiting for IO',
                    desc: 'CPU 空等磁盘/网络 IO 完成的时间。持续偏高说明 IO 慢。' },
            'st': { label: '被偷', unit: '%', en: 'Time stolen from a virtual machine',
                    desc: '虚拟机想用 CPU 却被宿主机分给别的虚拟机的时间。云主机上持续偏高说明被“超卖”。' }
        }
    }
};

var allTimeSeries = {};   // name -> TimeSeries
var allValueLabels = {};  // name -> { el, unit }
var charts = [];          // { smoothie, series: [{ ts, slot }] }

function formatValue(value, unit) {
    if (isNaN(value)) return '–';
    if (unit === 'kb') {
        if (value >= 1024 * 1024) return (value / 1024 / 1024).toFixed(2) + ' GB';
        if (value >= 1024) return (value / 1024).toFixed(1) + ' MB';
        return Math.round(value) + ' KB';
    }
    if (unit === '%') return Math.round(value) + '%';
    return Math.round(value).toLocaleString() + ' ' + unit;
}

// 坐标轴刻度：数字用紧凑写法
function axisFormatter(unit) {
    return function(v) {
        if (unit === 'kb') return formatValue(v, 'kb');
        if (unit === '%') return Math.round(v) + '%';
        if (v >= 10000) return (v / 1000).toFixed(0) + 'K';
        return String(Math.round(v));
    };
}

function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function hexToRgba(hex, alpha) {
    var h = hex.replace('#', '');
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function(c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

function tooltipFormatter(timestamp, data) {
    var t = new Date(timestamp);
    var pad = function(n) { return (n < 10 ? '0' : '') + n; };
    var html = '<div class="tt-time">' + pad(t.getHours()) + ':' + pad(t.getMinutes()) + ':' + pad(t.getSeconds()) + '</div>';
    for (var i = 0; i < data.length; i++) {
        var o = data[i].series.options;
        html += '<div class="tt-row"><i class="swatch" style="background:' + o.strokeStyle + '"></i>' +
                '<span>' + escapeHtml(o.statName + ' ' + o.statLabel) + '</span>' +
                '<b>' + escapeHtml(formatValue(data[i].value, o.statUnit)) + '</b></div>';
    }
    return html;
}

// 读取当前主题的颜色并应用到所有图表（主题切换时也会调用）
function applyTheme() {
    var surface = cssVar('--surface-1'), grid = cssVar('--grid'),
        muted = cssVar('--text-muted'), baseline = cssVar('--baseline');
    charts.forEach(function(c) {
        var o = c.smoothie.options;
        o.grid.fillStyle = surface;
        o.grid.strokeStyle = grid;
        o.labels.fillStyle = muted;
        o.tooltipLine.strokeStyle = baseline;
        c.series.forEach(function(s) {
            var color = cssVar('--series-' + s.slot);
            var opts = c.smoothie.getTimeSeriesOptions(s.ts);
            opts.strokeStyle = color;
            opts.fillStyle = hexToRgba(color, 0.10);
        });
    });
}

function initCharts() {
    Object.each(descriptions, function(sectionName, section) {
        var el = $('.chart.template').clone().removeClass('template').insertBefore('footer.tips');
        el.find('.title').text(section.title);
        el.find('.section-desc').text(section.desc);

        var firstUnit = Object.values(section.stats)[0].unit;
        var smoothie = new SmoothieChart({
            responsive: true,
            millisPerPixel: 100,           // 约 1 分钟的窗口
            interpolation: 'bezier',
            minValue: 0,
            maxValue: section.maxValue,
            maxValueScale: 1.1,
            scaleSmoothing: 0.2,
            grid: {
                lineWidth: 1,
                millisPerLine: 10000,      // 每 10 秒一条竖线
                verticalSections: 4,
                borderVisible: false,
                sharpLines: true
            },
            labels: {
                fontSize: 11,
                fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
                precision: 0
            },
            yMaxFormatter: axisFormatter(firstUnit),
            yMinFormatter: axisFormatter(firstUnit),
            tooltip: true,
            tooltipLine: { lineWidth: 1 },
            tooltipFormatter: tooltipFormatter
        });
        smoothie.streamTo(el.find('canvas').get(0), 1000);

        var chart = { smoothie: smoothie, series: [] };
        var slot = 1;
        Object.each(section.stats, function(name, info) {
            var ts = new TimeSeries();
            smoothie.addTimeSeries(ts, {
                lineWidth: 2,
                statName: name,
                statLabel: info.label,
                statUnit: info.unit
            });
            chart.series.push({ ts: ts, slot: slot });
            allTimeSeries[name] = ts;

            var row = el.find('.stat.template').clone().removeClass('template').appendTo(el.find('.stats'));
            row.attr('title', name + ': ' + info.en);
            row.find('.swatch').css('background', 'var(--series-' + slot + ')');
            row.find('.stat-name').text(name);
            row.find('.stat-label').text(info.label);
            row.find('.stat-desc').text(info.desc);
            allValueLabels[name] = { el: row.find('.stat-value'), unit: info.unit };
            slot++;
        });
        charts.push(chart);
    });
    applyTheme();
}

function updateTiles(s) {
    if (!isNaN(s.id)) $('#t-cpu').text((100 - s.id) + '%');
    if (!isNaN(s.free)) $('#t-mem').text(formatValue(s.free + (s.buff || 0) + (s.cache || 0), 'kb'));
    if (!isNaN(s.wa)) $('#t-wa').text(s.wa + '%');
    if (!isNaN(s.r)) $('#t-r').text(s.r + ' 个');
}

function receiveStats(stats) {
    var now = Date.now();
    Object.each(stats, function(name, value) {
        var ts = allTimeSeries[name];
        if (ts) {
            ts.append(now, value);
            var label = allValueLabels[name];
            label.el.text(formatValue(value, label.unit));
        }
    });
    updateTiles(stats);
}

function setConn(state, text) {
    $('#conn').attr('class', 'conn ' + state).find('.conn-text').text(text);
}

function streamStats() {
    var ws = new ReconnectingWebSocket(
        (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/');
    var lineCount;
    var colHeadings;

    ws.onopen = function() {
        setConn('ok', '已连接');
        lineCount = 0;
    };

    ws.onclose = function() {
        setConn('bad', '已断开，重连中…');
    };

    ws.onmessage = function(e) {
        switch (lineCount++) {
            case 0: // 第一行是分组标题，忽略
                break;
            case 1: // 列名
                colHeadings = e.data.trim().split(/ +/);
                break;
            default:
                var colValues = e.data.trim().split(/ +/);
                var stats = {};
                for (var i = 0; i < colHeadings.length; i++) {
                    stats[colHeadings[i]] = parseInt(colValues[i], 10);
                }
                receiveStats(stats);
        }
    };
}

// 主题：自动（跟随系统）/ 浅色 / 深色，记在浏览器本地
var THEMES = ['auto', 'light', 'dark'];
var THEME_NAMES = { auto: '自动', light: '浅色', dark: '深色' };

function setTheme(theme) {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    $('#theme').text('主题：' + THEME_NAMES[theme]).data('theme', theme);
    try { localStorage.setItem('vmstats-theme', theme); } catch (e) {}
    applyTheme();
}

function initTheme() {
    var saved = 'auto';
    try { saved = localStorage.getItem('vmstats-theme') || 'auto'; } catch (e) {}
    if (THEMES.indexOf(saved) < 0) saved = 'auto';
    setTheme(saved);
    $('#theme').on('click', function() {
        var cur = $(this).data('theme') || 'auto';
        setTheme(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]);
    });
    if (window.matchMedia) {
        var mq = window.matchMedia('(prefers-color-scheme: dark)');
        var onChange = function() { applyTheme(); };
        if (mq.addEventListener) mq.addEventListener('change', onChange);
        else if (mq.addListener) mq.addListener(onChange);
    }
}

$(function() {
    initCharts();
    initTheme();
    streamStats();
});
