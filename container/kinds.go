package main

import "bytes"

// Job kinds: what the converter does with an input, chosen by X-Job-Ext.
const (
	kindDeck  = "deck"
	kindDoc   = "doc"
	kindSheet = "sheet"
	kindPDF   = "pdf"
	kindVideo = "video"
	kindImage = "image"
)

var kindByExt = map[string]string{
	"pptx": kindDeck, "ppsx": kindDeck, "ppt": kindDeck, "pps": kindDeck, "odp": kindDeck,
	"docx": kindDoc, "doc": kindDoc, "odt": kindDoc, "rtf": kindDoc,
	"xlsx": kindSheet, "xls": kindSheet, "ods": kindSheet,
	"pdf": kindPDF,
	"mp4": kindVideo, "mov": kindVideo, "m4v": kindVideo, "webm": kindVideo,
	"heic": kindImage, "heif": kindImage,
}

// Error codes in /job/status. Machine-readable and stable; the detail goes to the container log only.
const (
	errBadMagic      = "bad_magic"
	errBadArchive    = "bad_archive"
	errBomb          = "bomb"
	errTooLarge      = "too_large"
	errTooManyPages  = "too_many_pages"
	errBadPageSize   = "bad_page_size"
	errBadMedia      = "bad_media"
	errConvertFailed = "convert_failed"
	errOutputInvalid = "output_invalid"
	errTimeout       = "timeout"
	errUpload        = "upload_failed"
	errInternal      = "internal"
)

var (
	magicZip  = []byte("PK\x03\x04")
	magicCFB  = []byte{0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1}
	magicEBML = []byte{0x1A, 0x45, 0xDF, 0xA3}
)

var heicBrands = []string{"heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"}

// atoms that may open a QuickTime or MP4 file when there is no ftyp box.
var movAtoms = []string{"ftyp", "moov", "mdat", "wide", "free", "skip"}

// magicOK reports whether head, the first bytes of the upload, matches what ext claims.
func magicOK(ext string, head []byte) bool {
	switch ext {
	case "pptx", "ppsx", "docx", "xlsx", "odp", "odt", "ods":
		return bytes.HasPrefix(head, magicZip)
	case "ppt", "pps", "doc", "xls":
		return bytes.HasPrefix(head, magicCFB)
	case "rtf":
		return bytes.HasPrefix(head, []byte("{\\rtf"))
	case "pdf":
		return bytes.Contains(head[:min(len(head), 1024)], []byte("%PDF-"))
	case "webm":
		return bytes.HasPrefix(head, magicEBML)
	case "mp4", "mov", "m4v":
		return len(head) >= 8 && containsStr(movAtoms, string(head[4:8]))
	case "heic", "heif":
		return heicBrandOK(head)
	}
	return false
}

// heicBrandOK accepts an ftyp box whose major or compatible brand is a HEIF image brand. AVIF is refused.
func heicBrandOK(head []byte) bool {
	if len(head) < 16 || string(head[4:8]) != "ftyp" {
		return false
	}
	size := int(head[0])<<24 | int(head[1])<<16 | int(head[2])<<8 | int(head[3])
	if size < 16 || size > len(head) {
		size = len(head)
	}
	if containsStr(heicBrands, string(head[8:12])) {
		return true
	}
	for i := 16; i+4 <= size; i += 4 {
		if containsStr(heicBrands, string(head[i:i+4])) {
			return true
		}
	}
	return false
}

func containsStr(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
