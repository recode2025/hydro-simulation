/**
 * hydrooj-similarity — evidence-metric visibility picker.
 *
 * Shared by the report pair table (columns) and the diff page (chips).
 * On trivial problems Seq/TF-IDF/Func/Struct saturate near 100% for everyone
 * and only e.g. Var carries signal, so metrics are individually hideable.
 * The selection persists in localStorage ("simEvMetrics": sparse object,
 * absent key or true = visible, false = hidden).
 */
(function () {
    'use strict';

    var KEY = 'simEvMetrics';
    var state = {};
    try {
        var raw = window.localStorage.getItem(KEY);
        var parsed = raw ? JSON.parse(raw) : null;
        if (parsed && typeof parsed === 'object') state = parsed;
    } catch (e) { /* storage unavailable or corrupted — fall back to all visible */ }

    function isVisible(m) { return state[m] !== false; }

    function applyMetric(m) {
        var on = isVisible(m);
        var targets = document.querySelectorAll('[data-m="' + m + '"]');
        for (var i = 0; i < targets.length; i++) {
            targets[i].classList.toggle('sim-col--off', !on);
        }
    }

    function save() {
        try { window.localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
    }

    function boot() {
        var boxes = document.querySelectorAll('input[data-sim-metric]');
        for (var i = 0; i < boxes.length; i++) {
            (function (box) {
                var m = box.getAttribute('data-sim-metric');
                box.checked = isVisible(m);
                var chip = box.closest('.sim-metricpick__chip');
                if (chip) chip.classList.toggle('is-off', !box.checked);
                box.addEventListener('change', function () {
                    if (box.checked) delete state[m]; // keep the store sparse
                    else state[m] = false;
                    save();
                    if (chip) chip.classList.toggle('is-off', !box.checked);
                    applyMetric(m);
                });
            })(boxes[i]);
        }
        var seen = {};
        var targets = document.querySelectorAll('[data-m]');
        for (var j = 0; j < targets.length; j++) seen[targets[j].getAttribute('data-m')] = true;
        for (var k in seen) if (seen.hasOwnProperty(k)) applyMetric(k);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
