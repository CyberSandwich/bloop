set -u
cd /tmp
now() { date +%s.%N; }
P=$(mktemp -d); mkdir -p "$P/user" /tmp/o
cp /opt/bloop/lo-registry.xcu "$P/user/registrymodifications.xcu"
HOME="$P" soffice --headless --norestore --nolockcheck --nodefault --nologo -env:UserInstallation=file://$P --convert-to pdf --outdir /tmp/o /fx/deck-100.pptx >/dev/null 2>&1
pdftocairo -pdf /tmp/o/deck-100.pdf /tmp/doc.pdf
echo "pdf bytes: $(stat -c %s /tmp/doc.pdf)"
: > /tmp/laps
lap() { # name command...
  local name=$1; shift
  local s; s=$(now)
  "$@" >/dev/null 2>&1
  local rc=$?
  local e; e=$(now)
  echo "$name $(awk -v s="$s" -v e="$e" 'BEGIN{print e-s}') $rc" >> /tmp/laps
}
for n in 20 21 22 23 24 25 26 27 28 29; do
  lap ppm_png pdftoppm -f $n -l $n -scale-to-x 3840 -scale-to-y -1 -png -singlefile /tmp/doc.pdf /tmp/p
  lap ppm_raw pdftoppm -f $n -l $n -scale-to-x 3840 -scale-to-y -1 -singlefile /tmp/doc.pdf /tmp/q
  lap webp3840_from_png vips copy /tmp/p.png "/tmp/a.webp[Q=80]"
  lap webp3840_from_ppm vips copy /tmp/q.ppm "/tmp/b.webp[Q=80]"
  lap webp3840_from_ppm_effort2 vips copy /tmp/q.ppm "/tmp/c.webp[Q=80,effort=2]"
  lap thumb1920_from_png vips thumbnail /tmp/p.png "/tmp/d.webp[Q=80]" 1920 --height 1000000
  lap thumb480_from_png vips thumbnail /tmp/p.png "/tmp/e.webp[Q=80]" 480 --height 1000000
  lap thumb1920_from_ppm vips thumbnail /tmp/q.ppm "/tmp/d.webp[Q=80]" 1920 --height 1000000
  lap thumb480_from_ppm vips thumbnail /tmp/q.ppm "/tmp/e.webp[Q=80]" 480 --height 1000000
  lap direct1920 pdftoppm -f $n -l $n -scale-to-x 1920 -scale-to-y -1 -singlefile /tmp/doc.pdf /tmp/r
  lap direct480 pdftoppm -f $n -l $n -scale-to-x 480 -scale-to-y -1 -singlefile /tmp/doc.pdf /tmp/s
done
echo "sizes: png $(stat -c %s /tmp/p.png) ppm $(stat -c %s /tmp/q.ppm) webp3840 $(stat -c %s /tmp/a.webp) webp3840e2 $(stat -c %s /tmp/c.webp)"
awk '{s[$1]+=$2; c[$1]++; if($3!=0)f[$1]++} END{for(k in s) printf "%-28s mean %.3f s over %d (failed %d)\n", k, s[k]/c[k], c[k], f[k]+0}' /tmp/laps | sort
