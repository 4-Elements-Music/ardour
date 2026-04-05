/*
 * Copyright (C) 2026 Paul Davis <paul@linuxaudiosystems.com>
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program; if not, write to the Free Software Foundation, Inc.,
 * 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA.
 */

#include "chord_box.h"
#include "midi_inspector.h"
#include "quantize_dialog.h"
#include "pbd/i18n.h"

MidiInspector::MidiInspector (EditingContext& ec)
	: chord_expander (_("Chord Editing"))
	, quantize_expander (_("Quantize"))
{
	chord_box = manage (new ChordBox);
	chord_expander.add (*chord_box);

	quantize_widget = manage (new QuantizeWidget (ec));
	quantize_expander.add (*quantize_widget);

	pack_start (chord_expander, false, false);
	pack_start (quantize_expander, false, false);

	Gtk::Requisition max;
	max.width = -1;
	max.height = -1;
	Gtk::Requisition req;

	chord_box->size_request (req);
	if (req.width > 0 && req.width > max.width) {
		max.width = req.width;
	}

	if (req.height > 0 && req.height > max.height) {
		max.height = req.height;
	}

	quantize_widget->size_request (req);
	if (req.width > 0 && req.width > max.width) {
		max.width = req.width;
	}

	if (req.height > 0 && req.height > max.height) {
		max.height = req.height;
	}

	set_border_width (12);
	set_size_request (max.width, max.height);
}
