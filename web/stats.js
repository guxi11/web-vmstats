var allTimeSeries = {};
var allValueLabels = {};

// unit: 'kb' 表示 vmstat 输出的单位是 KiB，页面会换算成 MB / GB 显示
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

function formatValue(value, unit) {
    if (isNaN(value)) return '-';
    if (unit === 'kb') {
        if (value >= 1024 * 1024) return (value / 1024 / 1024).toFixed(2) + ' GB';
        if (value >= 1024) return (value / 1024).toFixed(1) + ' MB';
        return value + ' KB';
    }
    return value + ' ' + unit;
}

function streamStats() {

    var ws = new ReconnectingWebSocket(
        (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/');
    var lineCount;
    var colHeadings;

    ws.onopen = function() {
        console.log('connect');
        $('#conn').text('已连接').attr('class', 'conn ok');
        lineCount = 0;
    };

    ws.onclose = function() {
        console.log('disconnect');
        $('#conn').text('已断开，重连中…').attr('class', 'conn bad');
    };

    ws.onmessage = function(e) {
        switch (lineCount++) {
            case 0: // ignore first line
                break;

            case 1: // column headings
                colHeadings = e.data.trim().split(/ +/);
                break;

            default: // subsequent lines
                var colValues = e.data.trim().split(/ +/);
                var stats = {};
                for (var i = 0; i < colHeadings.length; i++) {
                    stats[colHeadings[i]] = parseInt(colValues[i]);
                }
                receiveStats(stats);
        }
    };
}

function initCharts() {
    Object.each(descriptions, function(sectionName, section) {
        var el = $('.chart.template').clone().removeClass('template').insertBefore('footer.tips');

        el.find('.title').text(section.title);
        el.find('.section-desc').text(section.desc);

        var smoothie = new SmoothieChart({
            grid: {
                sharpLines: true,
                verticalSections: 5,
                strokeStyle: 'rgba(119,119,119,0.45)',
                millisPerLine: 1000
            },
            minValue: 0,
            labels: {
                disabled: true
            }
        });
        var canvas = el.find('canvas').get(0);
        canvas.width = Math.floor(el.width());
        smoothie.streamTo(canvas, 1000);

        var colors = chroma.brewer['Pastel2'];
        var index = 0;
        Object.each(section.stats, function(name, info) {
            var color = colors[index++];

            var timeSeries = new TimeSeries();
            smoothie.addTimeSeries(timeSeries, {
                strokeStyle: color,
                fillStyle: chroma(color).darken().alpha(0.5).css(),
                lineWidth: 3
            });
            allTimeSeries[name] = timeSeries;

            var statLine = el.find('.stat.template').clone().removeClass('template').appendTo(el.find('.stats'));
            statLine.attr('title', name + ': ' + info.en);
            statLine.find('.stat-name').text(name).css('color', color);
            statLine.find('.stat-label').text(info.label);
            statLine.find('.stat-desc').text(info.desc);
            allValueLabels[name] = { el: statLine.find('.stat-value').css('color', color), unit: info.unit };
        });
    });
}

function receiveStats(stats) {
    Object.each(stats, function(name, value) {
        var timeSeries = allTimeSeries[name];
        if (timeSeries) {
            timeSeries.append(Date.now(), value);
            var label = allValueLabels[name];
            label.el.text(formatValue(value, label.unit));
        }
    });
}

// 窗口尺寸变化时（例如两栏/单栏切换），让图表宽度跟随所在栏
function resizeCharts() {
    $('#charts > section.chart:not(.template)').each(function() {
        var canvas = $(this).find('canvas').get(0);
        var w = Math.floor($(this).width());
        if (w > 0 && canvas.width !== w) canvas.width = w;
    });
}

$(function() {
    initCharts();
    streamStats();
    $(window).on('resize', resizeCharts.debounce(150));
});
