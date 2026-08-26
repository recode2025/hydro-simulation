/**
 * hydrooj-similarity — plagiarism network canvas (zero-dependency).
 *
 * Force-directed layout: spring edges (ideal length shrinks as similarity
 * rises) + grid-bucketed repulsion + centering gravity, damped & annealed.
 * Interactions: drag node / pan / wheel zoom, hover tooltip with highlight,
 * click node to pin highlight, click edge to open the diff view.
 *
 * Payload (GET <data-url>?level=1):
 *   { nodes: [{id,label,degree,maxLevel,pairCount}],
 *     edges: [{u,v,sim,level,pid,ptitle,pairId,url}],
 *     problems, stats }
 */
(function () {
    'use strict';

    var LEVEL_COLORS = { 1: '#f2b544', 2: '#f0783c', 3: '#e02020' };
    var NODE_FILL = { 0: '#9aa5b1', 1: '#f2b544', 2: '#f0783c', 3: '#e02020' };
    var IDEAL_BASE = 220;   // px between weakly similar pairs
    var IDEAL_MIN = 70;     // px between identical pairs
    var REPULSION = 5200;
    var SPRING_K = 0.012;
    var GRAVITY = 0.012;
    var DAMPING = 0.85;
    var ALPHA_MIN = 0.005;

    function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

    function init() {
        var container = document.querySelector('[data-sim-graph]');
        if (!container) return;
        var url = container.getAttribute('data-url');
        var canvas = container.querySelector('canvas');
        var tooltip = container.querySelector('[data-sim-tooltip]');
        var emptyBox = container.querySelector('[data-sim-empty]');
        var statEl = document.querySelector('[data-sim-stat]');
        var failMsg = container.getAttribute('data-msg-fail') || 'Failed to load graph data';
        fetch(url + (url.indexOf('?') >= 0 ? '&' : '?') + 'level=1')
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (payload) {
                if (!payload || !payload.nodes) throw new Error('bad payload');
                new GraphView(container, canvas, tooltip, emptyBox, statEl, payload);
            })
            .catch(function (e) {
                // localized headline + raw detail, so a failed fetch can never
                // masquerade as "no pairs"
                emptyBox.textContent = failMsg + ' — ' + String(e && e.message ? e.message : e);
                emptyBox.hidden = false;
            });
    }

    function GraphView(container, canvas, tooltip, emptyBox, statEl, payload) {
        this.container = container;
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.tooltip = tooltip;
        this.emptyBox = emptyBox;
        this.statEl = statEl;

        this.nodeById = {};
        this.nodes = payload.nodes.map(function (n, i) {
            var v = {
                id: n.id, label: n.label,
                x: 0, y: 0, vx: 0, vy: 0,
                deg: 0, maxLevel: 0, visible: true, pinned: false,
            };
            this.nodeById[n.id] = v;
            return v;
        }, this);
        this.edges = payload.edges.map(function (e) {
            return {
                a: this.nodeById[e.u], b: this.nodeById[e.v],
                sim: e.sim, level: e.level, pid: e.pid,
                ptitle: e.ptitle, url: e.url, visible: true,
            };
        }, this);

        // seed positions on a golden-angle spiral so clusters separate early
        var GA = Math.PI * (3 - Math.sqrt(5));
        for (var i = 0; i < this.nodes.length; i++) {
            var r = 30 * Math.sqrt(i + 1);
            var a = i * GA;
            this.nodes[i].x = Math.cos(a) * r;
            this.nodes[i].y = Math.sin(a) * r;
        }

        this.scale = 1;
        this.ox = 0;
        this.oy = 0;
        this.alpha = 1;
        this.hoverNode = null;
        this.hoverEdge = null;
        this.focusNode = null;
        this.dragNode = null;
        this.panning = false;
        this.running = true;

        this.applyFilter();
        this.bindEvents();
        this.resize();
        var self = this;
        window.addEventListener('resize', function () { self.resize(); });
        this.loop = function () { self.tick(); };
        requestAnimationFrame(this.loop);
    }

    /* ---- visibility / degrees ---- */

    GraphView.prototype.applyFilter = function () {
        var checked = {};
        var boxes = document.querySelectorAll('[data-sim-level]');
        var any = false;
        for (var i = 0; i < boxes.length; i++) {
            checked[boxes[i].getAttribute('data-sim-level')] = boxes[i].checked;
            if (boxes[i].checked) any = true;
        }
        if (!any) { // never leave the canvas fully empty
            for (var j = 0; j < boxes.length; j++) { boxes[j].checked = true; checked[boxes[j].getAttribute('data-sim-level')] = true; }
        }
        var visibleEdges = 0;
        // two passes' worth of state reset lives here; runFilter is called
        // twice when the default checkbox set filters out EVERYTHING (e.g.
        // all pairs are Suspected but Suspected starts unchecked)
        var runFilter = function () {
            visibleEdges = 0;
            for (var k = 0; k < this.nodes.length; k++) {
                this.nodes[k].deg = 0;
                this.nodes[k].maxLevel = 0;
                this.nodes[k].visible = false;
            }
            for (var e = 0; e < this.edges.length; e++) {
                var edge = this.edges[e];
                edge.visible = checked[String(edge.level)] === true;
                if (edge.visible && edge.a && edge.b) {
                    visibleEdges++;
                    edge.a.deg++; edge.b.deg++;
                    edge.a.visible = edge.b.visible = true;
                    if (edge.level > edge.a.maxLevel) edge.a.maxLevel = edge.level;
                    if (edge.level > edge.b.maxLevel) edge.b.maxLevel = edge.level;
                }
            }
        }.bind(this);
        runFilter();
        if (visibleEdges === 0 && this.edges.length > 0) {
            // the checked levels have no edges — fall back to showing every
            // level instead of an empty canvas ("no pairs" lie)
            var boxes2 = document.querySelectorAll('[data-sim-level]');
            for (var b = 0; b < boxes2.length; b++) {
                boxes2[b].checked = true;
                checked[boxes2[b].getAttribute('data-sim-level')] = true;
            }
            runFilter();
        }
        var visibleNodes = 0;
        for (var n = 0; n < this.nodes.length; n++) if (this.nodes[n].visible) visibleNodes++;
        this.emptyBox.hidden = visibleEdges > 0;
        if (this.statEl) {
            this.statEl.textContent = visibleNodes + ' users · ' + visibleEdges + ' pairs';
        }
        var counts = { 1: 0, 2: 0, 3: 0 };
        for (var c = 0; c < this.edges.length; c++) counts[this.edges[c].level]++;
        var spans = document.querySelectorAll('[data-sim-count]');
        for (var s = 0; s < spans.length; s++) {
            spans[s].textContent = counts[spans[s].getAttribute('data-sim-count')] || 0;
        }
        this.kick();
    };

    /* ---- simulation ---- */

    GraphView.prototype.kick = function () {
        if (this.alpha < 0.3) this.alpha = 0.3;
        this.running = true;
    };

    GraphView.prototype.tick = function () {
        if (this.running) this.simulate();
        this.render();
        requestAnimationFrame(this.loop);
    };

    GraphView.prototype.simulate = function () {
        var nodes = this.nodes;
        var w = this.width / this.scale;
        var h = this.height / this.scale;
        var cx = 0;
        var cy = 0;
        var live = 0;
        for (var n0 = 0; n0 < nodes.length; n0++) {
            if (!nodes[n0].visible) continue;
            cx += nodes[n0].x; cy += nodes[n0].y; live++;
        }
        if (live) { cx /= live; cy /= live; }
        else { this.alpha = 0; }

        // grid-bucketed repulsion (near-linear in node count)
        var cell = 100;
        var grid = {};
        var key = function (x, y) { return Math.floor(x / cell) + ',' + Math.floor(y / cell); };
        for (var n1 = 0; n1 < nodes.length; n1++) {
            var node = nodes[n1];
            if (!node.visible) continue;
            var k = key(node.x, node.y);
            (grid[k] || (grid[k] = [])).push(node);
        }
        for (var n2 = 0; n2 < nodes.length; n2++) {
            var a = nodes[n2];
            if (!a.visible || a === this.dragNode) continue;
            var gx = Math.floor(a.x / cell);
            var gy = Math.floor(a.y / cell);
            for (var dx = -1; dx <= 1; dx++) {
                for (var dy = -1; dy <= 1; dy++) {
                    var bucket = grid[(gx + dx) + ',' + (gy + dy)];
                    if (!bucket) continue;
                    for (var b = 0; b < bucket.length; b++) {
                        var other = bucket[b];
                        if (other === a || !other.visible) continue;
                        var ddx = a.x - other.x;
                        var ddy = a.y - other.y;
                        var d2 = ddx * ddx + ddy * ddy;
                        if (d2 < 1) { d2 = 1; ddx = 0.5 + Math.random() * 0.1; ddy = 0.5; }
                        if (d2 > cell * cell) continue;
                        var f = (REPULSION * this.alpha) / d2;
                        var d = Math.sqrt(d2);
                        a.vx += (ddx / d) * f;
                        a.vy += (ddy / d) * f;
                    }
                }
            }
        }

        // springs: higher similarity => shorter ideal length
        for (var e = 0; e < this.edges.length; e++) {
            var edge = this.edges[e];
            if (!edge.visible || !edge.a || !edge.b) continue;
            var ex = edge.b.x - edge.a.x;
            var ey = edge.b.y - edge.a.y;
            var len = Math.sqrt(ex * ex + ey * ey) || 1;
            var ideal = IDEAL_BASE - (IDEAL_BASE - IDEAL_MIN) * edge.sim;
            var f2 = SPRING_K * (len - ideal) * this.alpha;
            var fx = (ex / len) * f2;
            var fy = (ey / len) * f2;
            if (edge.a !== this.dragNode) { edge.a.vx += fx; edge.a.vy += fy; }
            if (edge.b !== this.dragNode) { edge.b.vx -= fx; edge.b.vy -= fy; }
        }

        // gravity toward centroid + integrate with damping
        for (var n3 = 0; n3 < nodes.length; n3++) {
            var v = nodes[n3];
            if (!v.visible || v === this.dragNode) continue;
            v.vx += (cx - v.x) * GRAVITY;
            v.vy += (cy - v.y) * GRAVITY;
            v.vx *= DAMPING;
            v.vy *= DAMPING;
            var step = this.alpha * 12;
            v.x += clamp(v.vx, -step, step);
            v.y += clamp(v.vy, -step, step);
            v.x = clamp(v.x, -w, w);
            v.y = clamp(v.y, -h, h);
        }

        this.alpha *= 0.992;
        if (this.alpha < ALPHA_MIN) this.running = false;
    };

    /* ---- rendering ---- */

    GraphView.prototype.resize = function () {
        var dpr = window.devicePixelRatio || 1;
        this.width = this.container.clientWidth;
        this.height = this.container.clientHeight;
        this.canvas.width = Math.max(1, Math.floor(this.width * dpr));
        this.canvas.height = Math.max(1, Math.floor(this.height * dpr));
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.kick();
    };

    GraphView.prototype.toScreen = function (x, y) {
        return [this.width / 2 + (x * this.scale) + this.ox, this.height / 2 + (y * this.scale) + this.oy];
    };

    GraphView.prototype.toWorld = function (px, py) {
        return [(px - this.width / 2 - this.ox) / this.scale, (py - this.height / 2 - this.oy) / this.scale];
    };

    GraphView.prototype.isDark = function () {
        var el = document.documentElement;
        return el.getAttribute('data-mantine-color-scheme') === 'dark'
            || /theme--.*dark/.test(el.className);
    };

    GraphView.prototype.render = function () {
        var ctx = this.ctx;
        var dark = this.isDark();
        ctx.clearRect(0, 0, this.width, this.height);

        var focus = this.focusNode || this.hoverNode;
        var i;
        for (i = 0; i < this.edges.length; i++) {
            var edge = this.edges[i];
            if (!edge.visible || !edge.a || !edge.b) continue;
            var dim = focus && edge.a !== focus && edge.b !== focus;
            var p1 = this.toScreen(edge.a.x, edge.a.y);
            var p2 = this.toScreen(edge.b.x, edge.b.y);
            ctx.beginPath();
            ctx.moveTo(p1[0], p1[1]);
            ctx.lineTo(p2[0], p2[1]);
            ctx.globalAlpha = dim ? 0.08 : 0.35 + 0.55 * edge.sim;
            ctx.strokeStyle = LEVEL_COLORS[edge.level] || '#999';
            ctx.lineWidth = 1 + 2 * edge.sim;
            ctx.stroke();
        }
        ctx.globalAlpha = 1;

        var showLabels = this.nodes.length <= 80;
        for (i = 0; i < this.nodes.length; i++) {
            var node = this.nodes[i];
            if (!node.visible) continue;
            var p = this.toScreen(node.x, node.y);
            if (p[0] < -60 || p[0] > this.width + 60 || p[1] < -60 || p[1] > this.height + 60) continue;
            var r = 5 + Math.min(9, Math.sqrt(node.deg) * 2.2);
            var dimNode = focus && node !== focus && !this.connected(node, focus);
            ctx.globalAlpha = dimNode ? 0.15 : 1;
            ctx.beginPath();
            ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
            ctx.fillStyle = NODE_FILL[node.maxLevel] || NODE_FILL[0];
            ctx.fill();
            ctx.lineWidth = node === focus || node === this.hoverNode ? 3 : 1.5;
            ctx.strokeStyle = dark ? '#20242a' : '#fff';
            ctx.stroke();
            if (!dimNode && (showLabels || node === focus || node === this.hoverNode || node.deg >= 6)) {
                ctx.font = '11px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'top';
                ctx.fillStyle = dark ? 'rgba(230,232,235,.85)' : 'rgba(30,34,40,.85)';
                var label = node.label.length > 14 ? node.label.slice(0, 13) + '…' : node.label;
                ctx.fillText(label, p[0], p[1] + r + 3);
            }
            ctx.globalAlpha = 1;
        }
    };

    GraphView.prototype.connected = function (a, b) {
        for (var i = 0; i < this.edges.length; i++) {
            var e = this.edges[i];
            if (!e.visible) continue;
            if ((e.a === a && e.b === b) || (e.a === b && e.b === a)) return true;
        }
        return false;
    };

    /* ---- interaction ---- */

    GraphView.prototype.hitNode = function (px, py) {
        for (var i = this.nodes.length - 1; i >= 0; i--) {
            var node = this.nodes[i];
            if (!node.visible) continue;
            var p = this.toScreen(node.x, node.y);
            var r = 5 + Math.min(9, Math.sqrt(node.deg) * 2.2) + 5;
            var dx = px - p[0];
            var dy = py - p[1];
            if (dx * dx + dy * dy <= r * r) return node;
        }
        return null;
    };

    GraphView.prototype.hitEdge = function (px, py) {
        var best = null;
        var bestD = 6;
        for (var i = 0; i < this.edges.length; i++) {
            var edge = this.edges[i];
            if (!edge.visible || !edge.a || !edge.b) continue;
            var p1 = this.toScreen(edge.a.x, edge.a.y);
            var p2 = this.toScreen(edge.b.x, edge.b.y);
            var vx = p2[0] - p1[0];
            var vy = p2[1] - p1[1];
            var len2 = vx * vx + vy * vy || 1;
            var t = clamp(((px - p1[0]) * vx + (py - p1[1]) * vy) / len2, 0, 1);
            var qx = p1[0] + vx * t - px;
            var qy = p1[1] + vy * t - py;
            var d = Math.sqrt(qx * qx + qy * qy);
            if (d < bestD) { bestD = d; best = edge; }
        }
        return best;
    };

    GraphView.prototype.showTooltip = function (px, py, html) {
        this.tooltip.innerHTML = html;
        this.tooltip.hidden = false;
        var x = px + 14;
        var y = py + 14;
        if (x + this.tooltip.offsetWidth > this.width - 8) x = px - this.tooltip.offsetWidth - 10;
        if (y + this.tooltip.offsetHeight > this.height - 8) y = py - this.tooltip.offsetHeight - 10;
        this.tooltip.style.left = x + 'px';
        this.tooltip.style.top = y + 'px';
    };

    GraphView.prototype.hideTooltip = function () {
        this.tooltip.hidden = true;
        this.tooltip.style.left = '0px';
        this.tooltip.style.top = '0px';
    };

    GraphView.prototype.bindEvents = function () {
        var self = this;
        var last = null;

        this.canvas.addEventListener('pointerdown', function (ev) {
            ev.preventDefault();
            self.canvas.setPointerCapture(ev.pointerId);
            var rect = self.canvas.getBoundingClientRect();
            var px = ev.clientX - rect.left;
            var py = ev.clientY - rect.top;
            last = [px, py];
            var node = self.hitNode(px, py);
            if (node) {
                self.dragNode = node;
                node.vx = node.vy = 0;
            } else {
                self.panning = true;
            }
            self.container.setAttribute('data-sim-dragging', '1');
        });

        this.canvas.addEventListener('pointermove', function (ev) {
            var rect = self.canvas.getBoundingClientRect();
            var px = ev.clientX - rect.left;
            var py = ev.clientY - rect.top;
            if (self.dragNode) {
                var world = self.toWorld(px, py);
                self.dragNode.x = world[0];
                self.dragNode.y = world[1];
                self.kick();
                return;
            }
            if (self.panning && last) {
                self.ox += px - last[0];
                self.oy += py - last[1];
                last = [px, py];
                return;
            }
            // hover feedback
            var node = self.hitNode(px, py);
            var edge = node ? null : self.hitEdge(px, py);
            self.hoverNode = node;
            self.hoverEdge = edge;
            if (node) {
                var counts = { 1: 0, 2: 0, 3: 0 };
                for (var i = 0; i < self.edges.length; i++) {
                    var e = self.edges[i];
                    if (e.visible && (e.a === node || e.b === node)) counts[e.level]++;
                }
                self.showTooltip(px, py, '<b>' + node.label + '</b><br>'
                    + counts[3] + ' identical · ' + counts[2] + ' high · ' + counts[1] + ' suspected');
            } else if (edge) {
                self.showTooltip(px, py, '<b>' + edge.a.label + ' ↔ ' + edge.b.label + '</b><br>'
                    + '#' + edge.pid + ' ' + self.escapeHtml(edge.ptitle) + '<br>'
                    + (edge.sim * 100).toFixed(2) + '% · ' + self.levelName(edge.level)
                    + '<br>' + '▶ open diff');
            } else {
                self.hideTooltip();
            }
        });

        var endDrag = function () {
            if (self.dragNode) {
                self.dragNode.pinned = false;
                self.dragNode = null;
                self.kick();
            }
            self.panning = false;
            last = null;
            self.container.removeAttribute('data-sim-dragging');
        };
        this.canvas.addEventListener('pointerup', function (ev) {
            var rect = self.canvas.getBoundingClientRect();
            var px = ev.clientX - rect.left;
            var py = ev.clientY - rect.top;
            var node = self.hitNode(px, py);
            var edge = node ? null : self.hitEdge(px, py);
            if (node) {
                self.focusNode = self.focusNode === node ? null : node;
            } else if (edge) {
                window.open(edge.url, '_blank');
            } else {
                self.focusNode = null;
            }
            endDrag(ev);
        });
        this.canvas.addEventListener('pointercancel', endDrag);
        this.canvas.addEventListener('pointerleave', function () {
            self.hoverNode = null;
            self.hoverEdge = null;
            self.hideTooltip();
        });

        this.canvas.addEventListener('wheel', function (ev) {
            ev.preventDefault();
            var rect = self.canvas.getBoundingClientRect();
            var px = ev.clientX - rect.left;
            var py = ev.clientY - rect.top;
            var old = self.scale;
            self.scale = clamp(self.scale * (ev.deltaY < 0 ? 1.12 : 0.89), 0.15, 8);
            // keep the world point under the cursor fixed while zooming:
            // screen = w/2 + world*scale + o  =>  o = px - w/2 - world*scale
            var wx = (px - self.width / 2 - self.ox) / old;
            var wy = (py - self.height / 2 - self.oy) / old;
            self.ox = px - self.width / 2 - wx * self.scale;
            self.oy = py - self.height / 2 - wy * self.scale;
        }, { passive: false });

        var boxes = document.querySelectorAll('[data-sim-level]');
        for (var i = 0; i < boxes.length; i++) {
            boxes[i].addEventListener('change', function () { self.applyFilter(); });
        }
    };

    GraphView.prototype.levelName = function (level) {
        // localized name from the legend label (text minus input/spans)
        var box = document.querySelector('[data-sim-level="' + level + '"]');
        if (box && box.parentNode) {
            var clone = box.parentNode.cloneNode(true);
            var junk = clone.querySelectorAll('input, span');
            for (var i = 0; i < junk.length; i++) junk[i].remove();
            var text = (clone.textContent || '').trim();
            if (text) return text;
        }
        return level === 3 ? 'identical' : level === 2 ? 'high' : 'suspected';
    };

    GraphView.prototype.escapeHtml = function (s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
