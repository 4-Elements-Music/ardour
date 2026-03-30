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

#include "pbd/i18n.h"

using namespace ARDOUR;

ChordBox::ChordBox ()
	: triad_label (_("3-Note Chords (Triads)"))
	, tetrad_label (_("4-Note Chords (Tetrads)"))
	, inversion_label (_("Inversions"))
	, drop_label (_("Drop Notes"))
	, _root (0)
	, _culture (WesternEurope12TET)
{
	using namespace Gtk;
	using namespace Menu_Helpers;
	using namespace ArdourWidgets;

	/* these must match the enum decl order */
	culture_button.add_menu_elem (MenuElem (_("Western 12TET"), [this]() { set_culture (WesternEurope12TET); }));
	culture_button.add_menu_elem (MenuElem (_("Byzantine"), [this]() { set_culture (Byzantine); }));
	culture_button.add_menu_elem (MenuElem (_("Maqams"), [this]() { set_culture (Maqams); }));;
	culture_button.add_menu_elem (MenuElem (_("Hindustani"), [this]() { set_culture (Hindustani); }));;
	culture_button.add_menu_elem (MenuElem (_("Carnatic"), [this]() { set_culture (Carnatic); }));;
	culture_button.add_menu_elem (MenuElem (_("SEAsia"), [this]() { set_culture (SEAsia); }));;
	culture_button.add_menu_elem (MenuElem (_("China"), [this]() { set_culture (China); }));

	pack_start (culture_button, false, false);
	culture_button.show ();
	culture_button.set_active (0);

	set_border_width (12);
	set_spacing (6);
}

ChordBox::~ChordBox ()
{
}

void
ChordBox::set_culture (MusicalModeCulture culture)
{
	if (culture_button.get_active_row_number() != (int) culture) {
		culture_button.set_active ((int) culture);
	}

	_culture = culture;

	switch (_culture) {
	case WesternEurope12TET:
		if (western_vbox.children().empty()) {
			build_western ();
		}
		pack (western_vbox);
		break;
	case Byzantine:
		break;
	case Maqams:
		break;
	case Hindustani:
		break;
	case Carnatic:
		break;
	case SEAsia:
		break;
	case China:
		break;
	}
}


void
ChordBox::pack (Gtk::Widget& widget)
{
	if (western_vbox.get_parent()) {
		remove (western_vbox);
	}
	/* Other culture boxes go here */

	pack_start (widget, false, false);
}

void
ChordBox::build_western ()
{
	using namespace Gtk;
	using namespace Menu_Helpers;
	using namespace ArdourWidgets;

	root_dropdown.add_menu_elem (MenuElem (S_("Note|C"), [this]() { set_root (0); }));
	root_dropdown.set_active (0);

	triad_table.resize (3, 2);
	tetrad_table.resize (5, 2);
	inversion_table.resize (1, 2);
	drop_table.resize (2, 2);

	ArdourButton* but;
	int row = 0;
	int col = 0;

	but = manage (new ArdourButton);
	but->set_icon (ArdourIcon::ToolDraw);
	but->set_elements (ArdourButton::Element (ArdourButton::Edge|ArdourButton::Body|ArdourButton::Text|ArdourButton::VectorIcon));
	but->set_text (_("maj"));
	triad_table.attach (*but, col, col+1, row, row+1);
	col++;
	but = manage (new ArdourButton);
	but->set_icon (ArdourIcon::ToolDraw);
	but->set_elements (ArdourButton::Element (ArdourButton::Edge|ArdourButton::Body|ArdourButton::Text|ArdourButton::VectorIcon));
	but->set_text (_("min"));
	triad_table.attach (*but, col, col+1, row, row+1);
	col = 0;
	row++;


	but = manage (new ArdourButton);
	but->set_icon (ArdourIcon::ToolDraw);
	but->set_elements (ArdourButton::Element (ArdourButton::Edge|ArdourButton::Body|ArdourButton::Text|ArdourButton::VectorIcon));
	but->set_text (_("sus4"));
	triad_table.attach (*but, col, col+1, row, row+1);
	col++;
	but = manage (new ArdourButton);
	but->set_icon (ArdourIcon::ToolDraw);
	but->set_elements (ArdourButton::Element (ArdourButton::Edge|ArdourButton::Body|ArdourButton::Text|ArdourButton::VectorIcon));
	but->set_text (_("sus2"));
	triad_table.attach (*but, col, col+1, row, row+1);
	col = 0;
	row++;

	but = manage (new ArdourButton);
	but->set_icon (ArdourIcon::ToolDraw);
	but->set_elements (ArdourButton::Element (ArdourButton::Edge|ArdourButton::Body|ArdourButton::Text|ArdourButton::VectorIcon));
	but->set_text (_("dim"));
	triad_table.attach (*but, col, col+1, row, row+1);
	col++;
	but = manage (new ArdourButton);
	but->set_icon (ArdourIcon::ToolDraw);
	but->set_elements (ArdourButton::Element (ArdourButton::Edge|ArdourButton::Body|ArdourButton::Text|ArdourButton::VectorIcon));
	but->set_text (_("aug"));
	triad_table.attach (*but, col, col+1, row, row+1);
	col = 0;
	row++;

	triad_table.set_homogeneous (true);
	triad_table.set_col_spacings (6);

	/* Tetrads */

	row = 0;
	col = 0;

	but = manage (new ArdourButton);
	but->set_icon (ArdourIcon::ToolDraw);
	but->set_elements (ArdourButton::Element (ArdourButton::Edge|ArdourButton::Body|ArdourButton::Text|ArdourButton::VectorIcon));
	but->set_text (X_("\u0394"));
	tetrad_table.attach (*but, col, col+1, row, row+1);
	col++;
	but = manage (new ArdourButton);
	but->set_icon (ArdourIcon::ToolDraw);
	but->set_elements (ArdourButton::Element (ArdourButton::Edge|ArdourButton::Body|ArdourButton::Text|ArdourButton::VectorIcon));
	but->set_text (X_("7"));
	tetrad_table.attach (*but, col, col+1, row, row+1);
	col = 0;
	row++;

	but = manage (new ArdourButton);
	but->set_icon (ArdourIcon::ToolDraw);
	but->set_elements (ArdourButton::Element (ArdourButton::Edge|ArdourButton::Body|ArdourButton::Text|ArdourButton::VectorIcon));
	but->set_text (X_("-6"));
	tetrad_table.attach (*but, col, col+1, row, row+1);
	col++;
	but = manage (new ArdourButton);
	but->set_icon (ArdourIcon::ToolDraw);
	but->set_elements (ArdourButton::Element (ArdourButton::Edge|ArdourButton::Body|ArdourButton::Text|ArdourButton::VectorIcon));
	but->set_text (X_("-6"));
	tetrad_table.attach (*but, col, col+1, row, row+1);
	col = 0;
	row++;

	but = manage (new ArdourButton);
	but->set_icon (ArdourIcon::ToolDraw);
	but->set_elements (ArdourButton::Element (ArdourButton::Edge|ArdourButton::Body|ArdourButton::Text|ArdourButton::VectorIcon));
	but->set_text (X_("-7/b5"));
	tetrad_table.attach (*but, col, col+1, row, row+1);
	col++;
	but = manage (new ArdourButton);
	but->set_icon (ArdourIcon::ToolDraw);
	but->set_elements (ArdourButton::Element (ArdourButton::Edge|ArdourButton::Body|ArdourButton::Text|ArdourButton::VectorIcon));
	but->set_text (X_("-j7"));
	tetrad_table.attach (*but, col, col+1, row, row+1);
	col = 0;
	row++;

	but = manage (new ArdourButton);
	but->set_icon (ArdourIcon::ToolDraw);
	but->set_elements (ArdourButton::Element (ArdourButton::Edge|ArdourButton::Body|ArdourButton::Text|ArdourButton::VectorIcon));
	but->set_text (X_("su4/7"));
	tetrad_table.attach (*but, col, col+1, row, row+1);
	col++;
	but = manage (new ArdourButton);
	but->set_icon (ArdourIcon::ToolDraw);
	but->set_elements (ArdourButton::Element (ArdourButton::Edge|ArdourButton::Body|ArdourButton::Text|ArdourButton::VectorIcon));
	but->set_text (X_("sus2/7"));
	tetrad_table.attach (*but, col, col+1, row, row+1);
	col = 0;
	row++;

	but = manage (new ArdourButton);
	but->set_icon (ArdourIcon::ToolDraw);
	but->set_elements (ArdourButton::Element (ArdourButton::Edge|ArdourButton::Body|ArdourButton::Text|ArdourButton::VectorIcon));
	but->set_text (X_("dim"));
	tetrad_table.attach (*but, col, col+1, row, row+1);
	col++;
	but = manage (new ArdourButton);
	but->set_icon (ArdourIcon::ToolDraw);
	but->set_elements (ArdourButton::Element (ArdourButton::Edge|ArdourButton::Body|ArdourButton::Text|ArdourButton::VectorIcon));
	but->set_text (X_("\u0394 #5"));
	tetrad_table.attach (*but, col, col+1, row, row+1);
	col = 0;
	row++;

	tetrad_table.set_homogeneous (true);
	tetrad_table.set_col_spacings (6);

	/* Inversions */

	row = 0;
	col = 0;

	but = manage (new ArdourButton);
	but->set_elements (ArdourButton::Element (ArdourButton::Edge|ArdourButton::Body|ArdourButton::Text));
	but->set_text (_("Move Up"));
	inversion_table.attach (*but, col, col+1, row, row+1);
	col++;
	but = manage (new ArdourButton);
	but->set_elements (ArdourButton::Element (ArdourButton::Edge|ArdourButton::Body|ArdourButton::Text));
	but->set_text (_("Move Down"));
	inversion_table.attach (*but, col, col+1, row, row+1);
	col = 0;
	row++;

	inversion_table.set_homogeneous (true);
	inversion_table.set_col_spacings (6);

	/* Drops */

	row = 0;
	col = 0;

	but = manage (new ArdourButton);
	but->set_elements (ArdourButton::Element (ArdourButton::Edge|ArdourButton::Body|ArdourButton::Text));
	but->set_text (_("Drop 2"));
	drop_table.attach (*but, col, col+1, row, row+1);
	col++;
	but = manage (new ArdourButton);
	but->set_elements (ArdourButton::Element (ArdourButton::Edge|ArdourButton::Body|ArdourButton::Text));
	but->set_text (_("Drop 3"));
	drop_table.attach (*but, col, col+1, row, row+1);
	col = 0;
	row++;
	but = manage (new ArdourButton);
	but->set_elements (ArdourButton::Element (ArdourButton::Edge|ArdourButton::Body|ArdourButton::Text));
	but->set_text (_("Drop 2 + 4"));
	drop_table.attach (*but, col, col+2, row, row+1);
	col = 0;
	row++;

	drop_table.set_homogeneous (true);
	drop_table.set_col_spacings (6);


	triad_label.set_alignment (0.0, 0.5);
	tetrad_label.set_alignment (0.0, 0.5);
	inversion_label.set_alignment (0.0, 0.5);
	drop_label.set_alignment (0.0, 0.5);

	western_vbox.pack_start (root_dropdown, false, false);
	western_vbox.pack_start (triad_label, false, false);
	western_vbox.pack_start (triad_table, false, false);
	western_vbox.pack_start (tetrad_label, false, false);
	western_vbox.pack_start (tetrad_table, false, false);
	western_vbox.pack_start (inversion_label, false, false);
	western_vbox.pack_start (inversion_table, false, false);
	western_vbox.pack_start (drop_label, false, false);
	western_vbox.pack_start (drop_table, false, false);

	western_vbox.show_all ();
	western_vbox.set_spacing (6);

	pack_start (western_vbox);
}

void
ChordBox::set_root (int num)
{
	if (root_dropdown.get_active_row_number() != num) {
		root_dropdown.set_active (num);
	}
}

int
ChordBox::get_root () const
{
	return 0;
}
